import { randomUUID } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseQualityRules, qualityConfigName } from './quality-rules';

const maxFileSize = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export interface PackChange {
    path: string;
    before?: string;
    after: string;
}

export async function previewPack(source: string, workspace: string): Promise<PackChange[]> {
    const steering = join(source, 'steering');
    const rulesFolder = await checkDirectory(steering) ? steering : source;
    const entries = await readdir(rulesFolder, { withFileTypes: true });
    const markdown = entries.filter(entry => entry.isFile() && /\.md$/i.test(entry.name));
    if (markdown.length > 100) {
        throw new Error('A steering pack can contain at most 100 Markdown files.');
    }
    const proposals: { path: string; after: string }[] = [];
    const seen = new Set<string>();
    for (const entry of markdown.sort((a, b) => a.name.localeCompare(b.name))) {
        const key = entry.name.toLowerCase();
        if (seen.has(key) || /[<>:"/\\|?*]/.test(entry.name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(entry.name)) {
            throw new Error(`Invalid or duplicate steering filename: ${entry.name}`);
        }
        seen.add(key);
        const after = await readText(join(rulesFolder, entry.name));
        if (after === undefined) {
            throw new Error(`The pack changed while being read: ${entry.name}`);
        }
        proposals.push({ path: `.kiro/steering/${entry.name}`, after });
    }
    const quality = await readText(join(source, 'quality.json'));
    if (quality !== undefined) {
        const { problems } = parseQualityRules(quality);
        if (problems.length) {
            throw new Error(`quality.json: ${problems[0].message}`);
        }
        proposals.push({ path: `.kiro/${qualityConfigName}`, after: quality });
    }
    if (!proposals.length) {
        throw new Error('Choose a pack folder containing steering Markdown or quality.json.');
    }
    await checkWorkspaceDirectories(workspace, markdown.length > 0);
    const changes: PackChange[] = [];
    for (const proposal of proposals) {
        const before = await readText(join(workspace, proposal.path));
        if (before !== proposal.after) {
            changes.push({ ...proposal, before });
        }
    }
    return changes;
}

export async function applyPack(workspace: string, changes: PackChange[], isDirty: (file: string) => boolean) {
    const hasSteering = changes.some(change => change.path.startsWith('.kiro/steering/'));
    await checkWorkspaceDirectories(workspace, hasSteering);
    for (const change of changes) {
        await verifyBefore(workspace, change, isDirty);
    }
    await mkdir(join(workspace, hasSteering ? '.kiro/steering' : '.kiro'), { recursive: true });
    const applied: PackChange[] = [];
    try {
        for (const change of changes) {
            await checkWorkspaceDirectories(workspace, hasSteering);
            const target = join(workspace, change.path);
            await writeAtomic(target, change.after, change.before === undefined, async () => {
                await checkWorkspaceDirectories(workspace, hasSteering);
                await verifyBefore(workspace, change, isDirty);
            });
            applied.push(change);
        }
    } catch (error) {
        const rollbackFailures: string[] = [];
        for (const change of applied.reverse()) {
            try {
                await checkWorkspaceDirectories(workspace, hasSteering);
                const target = await verifyBefore(workspace, { ...change, before: change.after }, isDirty);
                if (change.before === undefined) {
                    await unlink(target);
                } else {
                    await writeAtomic(target, change.before, false, async () => {
                        await checkWorkspaceDirectories(workspace, hasSteering);
                        await verifyBefore(workspace, { ...change, before: change.after }, isDirty);
                    });
                }
            } catch {
                rollbackFailures.push(change.path);
            }
        }
        if (rollbackFailures.length) {
            throw new Error(`The pack was interrupted. Review these files before retrying: ${rollbackFailures.join(', ')}.`);
        }
        throw error;
    }
}

async function verifyBefore(workspace: string, change: PackChange, isDirty: (file: string) => boolean) {
    const target = join(workspace, change.path);
    if (await readText(target) !== change.before || isDirty(target)) {
        throw new Error(`${change.path} changed since preview or has unsaved edits. Save any edits and preview the pack again.`);
    }
    return target;
}

async function writeAtomic(target: string, text: string, create: boolean, verify: () => Promise<void>) {
    const temp = join(dirname(target), `.rpa-kiro-${randomUUID()}.tmp`);
    try {
        await writeFile(temp, text, { flag: 'wx' });
        if (!create) {
            await chmod(temp, (await lstat(target)).mode & 0o777);
        }
        await verify();
        if (create) {
            await link(temp, target);
        } else {
            await rename(temp, target);
        }
    } finally {
        await unlink(temp).catch(() => {});
    }
}

async function checkWorkspaceDirectories(workspace: string, steering: boolean) {
    await checkDirectory(join(workspace, '.kiro'));
    if (steering) {
        await checkDirectory(join(workspace, '.kiro', 'steering'));
    }
}

async function checkDirectory(path: string) {
    const stats = await pathStat(path);
    if (stats && !stats.isDirectory()) {
        throw new Error(`Expected a regular directory at ${path}.`);
    }
    return Boolean(stats);
}

async function readText(path: string) {
    const stats = await pathStat(path);
    if (!stats) {
        return undefined;
    }
    if (!stats.isFile() || stats.size > maxFileSize) {
        throw new Error(`Expected a regular UTF-8 file up to 256 KiB at ${path}.`);
    }
    try {
        return utf8.decode(await readFile(path));
    } catch {
        throw new Error(`Could not read a UTF-8 file at ${path}.`);
    }
}

async function pathStat(path: string) {
    try {
        return await lstat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
        return undefined;
    }
}
