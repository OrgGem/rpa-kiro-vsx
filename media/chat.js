(() => {
    const vscode = acquireVsCodeApi();
    const byId = id => document.getElementById(id);
    const transcript = byId('transcript');
    const welcome = byId('welcome');
    const prompt = byId('prompt');
    const status = byId('status');
    const tools = new Map();
    let message;
    let busy = false;
    let canLoad = true;
    let canConfigure = false;
    let offeredDraft;

    function dismissDraft() {
        offeredDraft = undefined;
        byId('draft-offer').hidden = true;
    }

    function insertDraft(text) {
        dismissDraft();
        prompt.value = text;
        prompt.focus();
        prompt.setSelectionRange(0, 0);
        prompt.scrollTop = 0;
    }

    function refreshControls() {
        byId('send').disabled = busy;
        byId('new').disabled = busy;
        byId('load').disabled = busy || !canLoad;
        byId('configure').disabled = busy;
        byId('configure').hidden = !canConfigure;
    }

    function setStatus(text, error = false) {
        status.textContent = text;
        status.classList.toggle('error', error);
    }

    function append(update) {
        const shouldScroll = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 64;
        welcome.hidden = true;
        update();
        if (shouldScroll) {
            transcript.scrollTop = transcript.scrollHeight;
        }
    }

    function chunk(role, text, id) {
        append(() => {
            if (!message || message.role !== role || message.id !== id) {
                const article = document.createElement('article');
                article.className = role;
                const label = document.createElement('h2');
                label.textContent = role === 'user' ? 'You' : 'Kiro';
                const body = document.createElement('p');
                const node = document.createTextNode('');
                body.append(node);
                article.append(label, body);
                transcript.append(article);
                message = { role, id, node };
            }
            message.node.appendData(text);
        });
    }

    function renderTool({ id, title, status: toolStatus }) {
        append(() => {
            let tool = tools.get(id);
            if (!tool) {
                message = undefined;
                const row = document.createElement('p');
                row.className = 'tool';
                transcript.append(row);
                tool = { row, title: 'Tool', status: 'pending' };
                tools.set(id, tool);
            }
            tool.title = title ?? tool.title;
            tool.status = toolStatus ?? tool.status;
            tool.row.textContent = `${tool.title} · ${tool.status.replaceAll('_', ' ')}`;
        });
    }

    for (const id of ['new', 'load', 'configure', 'output']) {
        byId(id).addEventListener('click', () => {
            if (id !== 'output') {
                busy = true;
                refreshControls();
            }
            vscode.postMessage({ type: id });
        });
    }
    byId('stop').addEventListener('click', () => {
        byId('stop').disabled = true;
        setStatus('Cancelling…');
        vscode.postMessage({ type: 'cancel' });
    });
    byId('accept-draft').addEventListener('click', () => {
        if (offeredDraft) {
            insertDraft(offeredDraft);
        }
    });
    byId('dismiss-draft').addEventListener('click', dismissDraft);
    byId('composer').addEventListener('submit', event => {
        event.preventDefault();
        if (!busy && prompt.value.trim()) {
            busy = true;
            refreshControls();
            vscode.postMessage({ type: 'prompt', text: prompt.value });
        }
    });
    prompt.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
            event.preventDefault();
            byId('composer').requestSubmit();
        }
    });
    window.addEventListener('message', ({ data }) => {
        switch (data.type) {
            case 'ready':
                byId('folder').textContent = data.folder;
                break;
            case 'draft':
                if (prompt.value.trim()) {
                    offeredDraft = data.text;
                    byId('draft-offer').hidden = false;
                } else {
                    insertDraft(data.text);
                }
                break;
            case 'busy':
                busy = true;
                setStatus('Working…');
                refreshControls();
                break;
            case 'idle':
                busy = false;
                message = undefined;
                byId('stop').hidden = true;
                if (status.textContent === 'Working…') {
                    setStatus('Ready');
                }
                refreshControls();
                break;
            case 'capabilities':
                canLoad = data.load;
                refreshControls();
                break;
            case 'disconnected':
                canLoad = true;
                byId('session').textContent = 'Disconnected';
                refreshControls();
                break;
            case 'session':
                message = undefined;
                tools.clear();
                welcome.hidden = false;
                welcome.textContent = 'Session ready. Ask Kiro a question about this workspace.';
                transcript.replaceChildren(welcome);
                byId('session').textContent = `Session ${data.sessionId}`;
                break;
            case 'config':
                canConfigure = data.selections.length > 0;
                byId('configuration').textContent = data.selections.join(' · ');
                refreshControls();
                break;
            case 'promptStarted':
                message = undefined;
                if (prompt.value.trim() === data.text) {
                    prompt.value = '';
                }
                chunk('user', data.text);
                setStatus('Kiro is responding…');
                byId('stop').hidden = false;
                byId('stop').disabled = false;
                break;
            case 'chunk':
                chunk(data.role, data.text, data.messageId);
                break;
            case 'tool':
                renderTool(data);
                break;
            case 'status':
            case 'error':
                setStatus(data.text, data.type === 'error');
                break;
        }
    });
    vscode.postMessage({ type: 'ready' });
})();
