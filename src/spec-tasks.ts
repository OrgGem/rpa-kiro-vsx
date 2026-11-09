const taskStates = { ' ': 'pending', x: 'done', '~': 'in progress', '-': 'queued' } as const;

export interface SpecTask {
    line: number;
    title: string;
    state: typeof taskStates[keyof typeof taskStates];
    optional: boolean;
}

export function parseSpecTasks(markdown: string): SpecTask[] {
    const tasks: SpecTask[] = [];
    let fence: string | undefined;
    markdown.split(/\r?\n/).forEach((line, index) => {
        const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
            if (marker && marker[1].startsWith(fence) && !marker[2].trim()) {
                fence = undefined;
            }
            return;
        }
        if (marker) {
            fence = marker[1];
            return;
        }
        const checkbox = /^\s*(?:[-*+]|\d+[.)])\s+\[([ x~-])\](\*)?\s+(.+?)\s*$/i.exec(line);
        if (checkbox && checkbox[3].trim()) {
            const state = checkbox[1].toLowerCase() as keyof typeof taskStates;
            tasks.push({ line: index, title: checkbox[3], state: taskStates[state], optional: Boolean(checkbox[2]) });
        }
    });
    return tasks;
}

export function remainingRequiredTasks(tasks: SpecTask[]) {
    return tasks.filter(task => !task.optional && task.state !== 'done');
}

export function buildSpecPrompt(specPath: string, files: string[], tasks?: SpecTask[]) {
    const filesToRead = files.map(file => `- ${JSON.stringify(`${specPath}/${file}`)}`).join('\n');
    if (!tasks) {
        return `Review the Kiro spec at ${JSON.stringify(specPath)}.\n\nRead the available spec files:\n${filesToRead}\n\nReport gaps, inconsistencies, and missing acceptance criteria or tests. Include file and line references when possible. Do not modify files.`;
    }
    const selected = tasks.map(task => `- Line ${task.line + 1}: ${JSON.stringify(task.title)}`).join('\n');
    return `Implement only the selected tasks for the Kiro spec at ${JSON.stringify(specPath)}.\n\nRead the available spec files:\n${filesToRead}\n\nSelected checkboxes in tasks.md:\n${selected}\n\nConfirm each task against the current checklist before starting. If a selected task is already complete or depends on an unselected task, report it instead of expanding the scope. Run the relevant checks and mark each selected task complete in tasks.md only after verifying its work. Summarize the changes and checks.`;
}
