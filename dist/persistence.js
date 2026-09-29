import { open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
/** Replace one complete private snapshot only after its contents are durable. */
export async function writeJson(path, value) {
    const temp = `${path}.${randomUUID()}.tmp`;
    let created = false;
    try {
        const file = await open(temp, 'wx', 0o600);
        created = true;
        try {
            await file.writeFile(JSON.stringify(value));
            await file.sync();
        }
        finally {
            await file.close();
        }
        await rename(temp, path);
        created = false;
        const directory = await open(dirname(path), 'r');
        try {
            await directory.sync();
        }
        finally {
            await directory.close();
        }
    }
    finally {
        // Includes failed writes before rename; never remove the committed snapshot.
        if (created)
            await unlink(temp).catch(() => { });
    }
}
