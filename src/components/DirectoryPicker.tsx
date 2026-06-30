import { open } from "@tauri-apps/plugin-dialog";

export async function pickDirectory(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "选择工作目录",
  });
  return selected as string | null;
}
