import { basename } from 'node:path';
import { RE2 } from 're2-wasm';
import { parseDocument } from 'yaml';

export const qualityConfigName = 'rpa-quality.json';
type Severity = 'error' | 'warning' | 'info';

export interface QualityProblem {
    code: string;
    message: string;
    severity: Severity;
    offset: number;
    length: number;
}

type Rule = {
    id: string;
    message: string;
    severity: Severity;
    fileTypes: string[];
    testFilesOnly: boolean;
} & ({ type: 'regex' | 'filename'; pattern: RE2 } | { type: 'filesize'; maxSize: number });

const severities: readonly Severity[] = ['error', 'warning', 'info'];
const inclusionModes = ['always', 'fileMatch', 'manual', 'auto'];

export function checkSteering(text: string): QualityProblem[] {
    const start = /^\uFEFF?---[ \t]*\r?\n/.exec(text);
    if (!start) {
        return [];
    }
    const rest = text.slice(start[0].length);
    const end = /^---[ \t]*\r?$/m.exec(rest);
    const issue = (message: string, offset = 0) => problem('steering-frontmatter', message, 'error', offset);
    if (!end) {
        return [issue('Close the YAML front matter with --- on its own line.')];
    }
    const yamlText = rest.slice(0, end.index);
    const doc = parseDocument(yamlText);
    if (doc.errors.length) {
        return doc.errors.map(error => issue(error.message.split('\n')[0], start[0].length + error.pos[0]));
    }
    let data: unknown;
    try {
        data = doc.toJS({ maxAliasCount: 0 });
    } catch {
        return [issue('Steering front matter must use plain YAML values.', start[0].length)];
    }
    if (data == null) {
        return [];
    }
    if (typeof data !== 'object' || Array.isArray(data)) {
        return [issue('Steering front matter must be a YAML mapping.', start[0].length)];
    }
    const { inclusion, fileMatchPattern, description } = data as Record<string, unknown>;
    if (inclusion !== undefined && (typeof inclusion !== 'string' || !inclusionModes.includes(inclusion))) {
        return [issue('Use always, fileMatch, manual, or auto for inclusion.', start[0].length)];
    }
    if (inclusion === 'fileMatch' && !nonempty(fileMatchPattern)
        && !(Array.isArray(fileMatchPattern) && fileMatchPattern.length && fileMatchPattern.every(nonempty))) {
        return [issue('fileMatch requires a fileMatchPattern string or a list of patterns.', start[0].length)];
    }
    if (inclusion === 'auto' && !nonempty(description)) {
        return [issue('Auto inclusion requires a description.', start[0].length)];
    }
    return [];
}

export function parseQualityRules(text: string): { rules: Rule[]; problems: QualityProblem[] } {
    const rules: Rule[] = [];
    const problems: QualityProblem[] = [];
    let hooks: unknown;
    try {
        hooks = JSON.parse(text.replace(/^\uFEFF/, ''))?.hooks;
    } catch {
        return { rules, problems: [problem('quality-config', 'The quality configuration is not valid JSON.', 'error')] };
    }
    if (!Array.isArray(hooks) || hooks.length > 100) {
        return { rules, problems: [problem('quality-config', 'Provide a hooks array with at most 100 rules.', 'error')] };
    }
    const ids = new Set<string>();
    for (const [index, hook] of hooks.entries()) {
        try {
            const rule = parseRule(hook);
            if (ids.has(rule.id)) {
                throw new Error(`Duplicate rule ID "${rule.id}".`);
            }
            ids.add(rule.id);
            rules.push(rule);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Invalid rule.';
            problems.push(problem('quality-config', `Rule ${index + 1}: ${message}`, 'error'));
        }
    }
    return { rules, problems };
}

function parseRule(input: unknown): Rule {
    const hook = input as Record<string, unknown> | null;
    const validation = hook?.validation as Record<string, unknown> | null;
    if (!nonempty(hook?.id) || !nonempty(validation?.message)) {
        throw new Error('Provide id and validation.message.');
    }
    if (hook.trigger !== undefined && hook.trigger !== 'onFileSave') {
        throw new Error('Only the onFileSave trigger is supported.');
    }
    const severity = (hook.severity ?? 'warning') as Severity;
    if (!severities.includes(severity)) {
        throw new Error('Severity must be error, warning, or info.');
    }
    if (!Array.isArray(hook.fileTypes) || !hook.fileTypes.length
        || !hook.fileTypes.every(type => typeof type === 'string' && /^(?:\*|(?:\*\.|\.)?[a-z\d_-]+(?:\.[a-z\d_-]+)*)$/i.test(type))) {
        throw new Error('Provide fileTypes with extensions such as "ts", ".ts", "*.ts", or "*".');
    }
    const base = {
        id: hook.id,
        message: validation.message,
        severity,
        fileTypes: hook.fileTypes.map((type: string) => type.toLowerCase().replace(/^\*?\.(?=.)/, '')),
        testFilesOnly: validation.applyOnlyToTestFiles === true,
    };
    const type = validation.type;
    if (type === 'filesize' && typeof validation.maxSize === 'number' && Number.isFinite(validation.maxSize) && validation.maxSize > 0) {
        return { ...base, type, maxSize: validation.maxSize };
    }
    if ((type === 'regex' || type === 'filename') && nonempty(validation.pattern) && validation.pattern.length <= 512) {
        try {
            return { ...base, type, pattern: new RE2(validation.pattern, type === 'regex' ? 'gmu' : 'u') };
        } catch {
            throw new Error('Pattern is invalid or uses syntax unsupported by RE2.');
        }
    }
    throw new Error('Use regex or filename with a pattern, or filesize with a positive maxSize in KiB.');
}

export function checkQuality(relativePath: string, text: string, rules: Rule[]) {
    const filename = basename(relativePath).toLowerCase();
    const isTest = /(?:^|[./_-])(?:tests?|specs?|__tests__)(?:[./_-]|$)/i.test(relativePath);
    const size = Buffer.byteLength(text, 'utf8') / 1024;
    const hasSurrogates = /[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(text);
    const issues: QualityProblem[] = [];
    for (const rule of rules) {
        if ((rule.testFilesOnly && !isTest) || !rule.fileTypes.some(type => type === '*' || filename.endsWith(`.${type}`))) {
            continue;
        }
        if (rule.type === 'filesize') {
            if (size > rule.maxSize) {
                issues.push(problem(rule.id, rule.message.replaceAll('{size}', size.toFixed(2)), rule.severity));
            }
        } else if (rule.type === 'filename') {
            if (!rule.pattern.test(basename(relativePath))) {
                issues.push(problem(rule.id, rule.message, rule.severity));
            }
        } else if (size <= 512) {
            rule.pattern.lastIndex = 0;
            let codePoints = 0;
            let offset = 0;
            for (let count = 0; count < 20; count++) {
                const match = rule.pattern.exec(text);
                if (!match) {
                    break;
                }
                const length = match[0]?.length ?? 0;
                // RE2 reports Unicode code points, while VS Code uses UTF-16 offsets.
                if (hasSurrogates) {
                    while (codePoints < match.index) {
                        offset += (text.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
                        codePoints++;
                    }
                }
                issues.push(problem(rule.id, rule.message, rule.severity, hasSurrogates ? offset : match.index, length));
                if (!length) {
                    rule.pattern.lastIndex++;
                }
            }
        }
        if (issues.length >= 100) {
            break;
        }
    }
    return issues.slice(0, 100);
}

function nonempty(value: unknown): value is string {
    return typeof value === 'string' && Boolean(value.trim());
}

function problem(code: string, message: string, severity: Severity, offset = 0, length = 1): QualityProblem {
    return { code, message, severity, offset, length };
}
