import {
  mkdir,
  readFile,
  rename,
  stat,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mediaRoot } from "./config.server";
import { ConversationError } from "../conversations/errors.server";

const KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.jpg$/;
function objectPath(key: string) {
  if (!KEY.test(key)) throw new Error("Invalid private media key.");
  return join(mediaRoot(), key);
}
export async function writeAsset(bytes: Buffer, key = `${randomUUID()}.jpg`) {
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    throw new Error("Invalid private image size.");
  const path = objectPath(key);
  await mkdir(mediaRoot(), { recursive: true, mode: 0o700 });
  const disk = await statfs(mediaRoot());
  if (
    Number(disk.bavail) * Number(disk.bsize) <
    bytes.length + 1024 * 1024 * 1024
  )
    throw new ConversationError(
      503,
      "Photo storage is temporarily full. Please try later.",
    );
  const temporary = `${path}.pending`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch((cleanupError: NodeJS.ErrnoException) => {
      if (cleanupError.code !== "ENOENT")
        console.error("[Roman] Private image temporary cleanup failed.");
    });
    throw error;
  }
  return key;
}
export async function readAsset(key: string) {
  const path = objectPath(key);
  const info = await stat(path);
  if (!info.isFile() || info.size < 1 || info.size > 10 * 1024 * 1024)
    throw new Error("Invalid private image size.");
  const bytes = await readFile(path);
  if (bytes.length !== info.size)
    throw new Error("Private image changed while reading.");
  return bytes;
}
export async function removeAsset(key: string) {
  try {
    await unlink(objectPath(key));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    await unlink(`${objectPath(key)}.pending`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
