//! 本地加密密钥存储。
//!
//! 替代系统 Keychain 的原因：
//! 1. macOS Keychain 每次读取都会弹授权对话框，体验糟糕。
//! 2. Linux 的 secret-service 在无桌面会话时不可用。
//! 3. 用同一套实现跨平台，逻辑更简单。
//!
//! 安全模型：
//! - 加密算法 AES-256-GCM（每条独立 12 字节 nonce）。
//! - 密钥由 `SHA256(APP_SALT || 机器 UUID || home || username)` 派生，
//!   即"机器+用户"绑定 —— 同一台机器同一个用户无需密码即可读取，
//!   把密钥文件 copy 到别的机器/用户也无法解密。
//! - 文件权限 0600（仅当前用户可读写）。

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

const APP_SALT: &[u8] = b"jcode-secret-store-v1-do-not-change";
const FILE_NAME: &str = "secrets.bin";

#[derive(Default, Serialize, Deserialize)]
struct SecretFile {
    #[serde(default = "default_version")]
    version: u32,
    #[serde(default)]
    entries: BTreeMap<String, String>,
}

fn default_version() -> u32 {
    1
}

struct Store {
    path: PathBuf,
    cipher: Aes256Gcm,
    file: SecretFile,
}

static STORE: Mutex<Option<Store>> = Mutex::new(None);

fn store_path() -> Result<PathBuf, String> {
    let dir = dirs::config_dir()
        .ok_or_else(|| "无法定位用户配置目录".to_string())?
        .join("jcode");
    fs::create_dir_all(&dir).map_err(|e| format!("创建配置目录失败: {}", e))?;
    Ok(dir.join(FILE_NAME))
}

fn derive_key() -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(APP_SALT);
    if let Some(id) = machine_id() {
        hasher.update(id.as_bytes());
    }
    if let Some(home) = dirs::home_dir() {
        hasher.update(home.to_string_lossy().as_bytes());
    }
    if let Ok(u) = std::env::var("USER") {
        hasher.update(u.as_bytes());
    }
    if let Ok(u) = std::env::var("USERNAME") {
        hasher.update(u.as_bytes());
    }
    let result = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&result);
    key
}

#[cfg(target_os = "macos")]
fn machine_id() -> Option<String> {
    use std::process::Command;
    let output = Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    for line in stdout.lines() {
        if line.contains("IOPlatformUUID") {
            // 行格式：    "IOPlatformUUID" = "ABCDEF12-..."
            let parts: Vec<&str> = line.splitn(5, '"').collect();
            if parts.len() >= 4 {
                return Some(parts[3].to_string());
            }
        }
    }
    None
}

#[cfg(windows)]
fn machine_id() -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    let output = Command::new("reg")
        .args([
            "query",
            "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .creation_flags(0x08000000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    let s = String::from_utf8_lossy(&output.stdout);
    for line in s.lines() {
        if line.to_lowercase().contains("machineguid") {
            return line.split_whitespace().last().map(|x| x.to_string());
        }
    }
    None
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn machine_id() -> Option<String> {
    fs::read_to_string("/etc/machine-id")
        .or_else(|_| fs::read_to_string("/var/lib/dbus/machine-id"))
        .ok()
        .map(|s| s.trim().to_string())
}

impl Store {
    fn open() -> Result<Self, String> {
        let path = store_path()?;
        let key_bytes = derive_key();
        let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(&key_bytes));

        let file = if path.exists() {
            let raw = fs::read(&path).map_err(|e| format!("读取密钥文件失败: {}", e))?;
            serde_json::from_slice(&raw).unwrap_or_default()
        } else {
            SecretFile {
                version: 1,
                entries: BTreeMap::new(),
            }
        };

        Ok(Self { path, cipher, file })
    }

    fn encrypt(&self, plaintext: &str) -> Result<String, String> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let ct = self
            .cipher
            .encrypt(Nonce::from_slice(&nonce), plaintext.as_bytes())
            .map_err(|e| format!("加密失败: {}", e))?;
        let mut payload = Vec::with_capacity(12 + ct.len());
        payload.extend_from_slice(&nonce);
        payload.extend_from_slice(&ct);
        Ok(STANDARD.encode(payload))
    }

    fn decrypt(&self, encoded: &str) -> Result<String, String> {
        let payload = STANDARD
            .decode(encoded)
            .map_err(|e| format!("Base64 解码失败: {}", e))?;
        if payload.len() < 13 {
            return Err("密文长度异常".to_string());
        }
        let (nonce, ct) = payload.split_at(12);
        let pt = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), ct)
            .map_err(|_| "解密失败：可能是机器或用户身份发生变化".to_string())?;
        String::from_utf8(pt).map_err(|e| format!("UTF-8 解码失败: {}", e))
    }

    fn save(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.file).map_err(|e| format!("序列化失败: {}", e))?;
        let tmp = self.path.with_extension("bin.tmp");
        fs::write(&tmp, &bytes).map_err(|e| format!("写入临时文件失败: {}", e))?;
        fs::rename(&tmp, &self.path).map_err(|e| format!("替换文件失败: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Ok(meta) = fs::metadata(&self.path) {
                let mut perms = meta.permissions();
                perms.set_mode(0o600);
                let _ = fs::set_permissions(&self.path, perms);
            }
        }
        Ok(())
    }

    fn set(&mut self, id: &str, value: &str) -> Result<(), String> {
        let enc = self.encrypt(value)?;
        self.file.entries.insert(id.to_string(), enc);
        self.save()
    }

    fn get(&self, id: &str) -> Result<Option<String>, String> {
        match self.file.entries.get(id) {
            Some(enc) => Ok(Some(self.decrypt(enc)?)),
            None => Ok(None),
        }
    }

    fn delete(&mut self, id: &str) -> Result<bool, String> {
        let removed = self.file.entries.remove(id).is_some();
        if removed {
            self.save()?;
        }
        Ok(removed)
    }

    fn has(&self, id: &str) -> bool {
        self.file.entries.contains_key(id)
    }
}

fn with_store<R>(f: impl FnOnce(&mut Store) -> Result<R, String>) -> Result<R, String> {
    let mut guard = STORE.lock().map_err(|e| format!("锁错误: {}", e))?;
    if guard.is_none() {
        *guard = Some(Store::open()?);
    }
    f(guard.as_mut().expect("store should be initialized"))
}

pub fn save(id: &str, value: &str) -> Result<(), String> {
    with_store(|s| s.set(id, value))
}

pub fn get(id: &str) -> Result<Option<String>, String> {
    with_store(|s| s.get(id))
}

pub fn delete(id: &str) -> Result<bool, String> {
    with_store(|s| s.delete(id))
}

pub fn has(id: &str) -> bool {
    with_store(|s| Ok(s.has(id))).unwrap_or(false)
}
