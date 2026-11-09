const assert = require('node:assert/strict');
const { test } = require('node:test');
const { buildSpecPrompt, parseSpecTasks, remainingRequiredTasks } = require('../dist/spec-tasks');

test('reads Kiro checkbox states, optional tasks and source lines', () => {
    const markdown = [
        '# Tasks', '- [X] 1. Setup', '  - [~] 1.1 Implement',
        '- [-] 2. Verify', '- [ ]* 3. Kiểm tra tùy chọn', '4. [ ] Add docs',
        '- [x]* Optional done', '- [ ]', 'Ordinary [ ] text',
    ].join('\r\n');
    const tasks = parseSpecTasks(markdown);
    assert.deepEqual(tasks, [
        { line: 1, title: '1. Setup', state: 'done', optional: false },
        { line: 2, title: '1.1 Implement', state: 'in progress', optional: false },
        { line: 3, title: '2. Verify', state: 'queued', optional: false },
        { line: 4, title: '3. Kiểm tra tùy chọn', state: 'pending', optional: true },
        { line: 5, title: 'Add docs', state: 'pending', optional: false },
        { line: 6, title: 'Optional done', state: 'done', optional: true },
    ]);
    assert.deepEqual(remainingRequiredTasks(tasks).map(task => task.line), [2, 3, 5]);
});

test('skips checkboxes inside fenced examples', () => {
    const markdown = [
        '~~~~md', '- [x] Example 1', '~~~', '- [ ] Example 2', '~~~~',
        '```md', '- [ ] Example 3', '```', '- [ ] Actual task',
    ].join('\n');
    assert.deepEqual(parseSpecTasks(markdown), [
        { line: 8, title: 'Actual task', state: 'pending', optional: false },
    ]);
});

test('scopes run prompts to selected task lines and makes review read-only', () => {
    const spec = '.kiro/specs/fix-login';
    const files = ['bugfix.md', 'design.md', 'tasks.md'];
    const [task] = parseSpecTasks('# Tasks\n- [ ] Fix callback handling');
    const run = buildSpecPrompt(spec, files, [task]);
    assert.match(run, /Implement only the selected tasks/);
    assert.match(run, /\.kiro\/specs\/fix-login\/bugfix\.md/);
    assert.match(run, /Line 2: "Fix callback handling"/);
    assert.match(run, /only after verifying/);
    const review = buildSpecPrompt(spec, ['bugfix.md']);
    assert.match(review, /Do not modify files/);
    assert.doesNotMatch(review, /tasks\.md/);
});
