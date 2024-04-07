import { html } from 'https://cdn.jsdelivr.net/npm/uhtml@4.5.0/node.js';

const CONFIG = {
    maxRunningTasks: 4,
    scriptAbortTimeout: 5000, // ms
    reportUpdateInterval: 1000,
    alwaysIncludeHarness: ['assert.js', 'sta.js'],
};

class ZipFile {
    root = null;

    constructor(jsZip) {
        const zipTree = this._getStructure(jsZip, (path) => path.match(/\.js$/) &&
                                                                          !path.match(/^(\.|__MACOSX)/) &&
                                                                          !path.match(/(_FIXTURE\.js$)/));
        // skip over first directory, in case of github-generated zips
        const filesInRoot = Object.keys(zipTree.files);
        if (filesInRoot.length === 1) {
            this.root = zipTree.files[filesInRoot[0]];
        } else {
            this.root = zipTree;
        }

        if (!this._checkTest262File(this.root)) {
            throw new Error("Doesn't look like a test262 bundle.");
        }
    }

    _getStructure(zip, predicate) {
        const structure = Object.create(null);
        structure.type = 'dir';
        structure.name = '.';
        structure.files = Object.create(null);
        structure.count = 0;
        zip.forEach(function(path, file) {
            if (!predicate(path)) return;
            path = path.split('/');
            if (path[path.length - 1] === '') return; // i.e. this is a directory
            let dir = structure;
            for (let i = 0; i < path.length - 1; ++i) {
                ++dir.count;
                if (!Object.prototype.hasOwnProperty.call(dir.files, path[i])) {
                    const f = dir.files[path[i]] = Object.create(null);
                    f.type = 'dir';
                    f.name = path[i];
                    f.files = Object.create(null);
                    f.count = 0;
                }
                dir = dir.files[path[i]];
            }
            if (!path[path.length - 1].match(/(_FIXTURE\.js$)/)) {
                ++dir.count;
            }
            const obj = Object.create(null);
            obj.type = 'file';
            obj.name = path[path.length - 1];
            obj.file = file;
            dir.files[path[path.length - 1]] = obj;
        });
        return structure;
    }

    _checkTest262File(tree) {
        return !(!tree.files.test || tree.files.test.type !== 'dir' ||
            !tree.files.harness || !tree.files.harness.files['assert.js'] || !tree.files.harness.files['sta.js']);
    }

    async extract(pathArr) {
        const file = pathArr.reduce(function(acc, name) { return acc.files[name]; }, this.root).file;
        return file.async("string");
    }
}

class TestRunner {
    static ERROR = Symbol.for("262Error");
    static NOCOMPLETE = Symbol.for("262NoComplete");

    _serviceResolveSrcHandler = null;
    _statusHandler = null;
    harness = {};
    iframes = [];
    iframeSrc = ''; // will be set to './blank.html' if the environment does not report error details when src = ''.
    runningTasks = [];
    backlogTasks = [];
    totalTasks = 0;
    finishedTasks = 0;
    results = [];
    isPaused = false;
    get isRunning() { return 0 < this.runningTasks.length + this.backlogTasks.length };

    constructor() {
        // Make some realms
        for (let i = 0; i < CONFIG.maxRunningTasks; ++i) {
            const iframe = document.body.appendChild(document.createElement('iframe'));
            iframe.style.display = 'none';
            this.iframes.push(iframe);
        }

        // Check if the environment reports errors from iframes with src = ''.
        this._runSources({ setup: '', source: 'throw new Error;', isModule: false, isAsync: false, needsAPI: false, path: ['test', 'path', 'test.js'] }, (e) => {
            if (e.message.match(/Script error\./i)) {
                this.iframeSrc = 'blank.html';
            }
        });
    }

    setHarness(harness) {
        this.harness = harness;
    }

    setServiceResolveSrcHandler(handler) {
        this._serviceResolveSrcHandler = handler;
    }

    setStatusHandler(handler) {
        this._statusHandler = handler;
    }

    _dispatchStatus(status) {
        if (typeof this._statusHandler === "function") {
            this._statusHandler(this, status);
        }
    }

    startNew(nodeList) {
        this.isPaused = false;
        this.runningTasks = [];
        this.backlogTasks = [];
        this.totalTasks = nodeList.length;
        this.finishedTasks = 0;
        this.results = [];

        this._dispatchStatus("begin");
        for (const li of nodeList) {
            const item = li.testItem;
            if (item.type !== 'file')
                continue;

            this._queueNewTask(item, li.path);
            this._runMoreTasks();
        }
    }

    pause() {
        this.isPaused = true;
        this._dispatchStatus("pause");
    }

    resume() {
        let i;
        this.isPaused = false;
        this._dispatchStatus("resume");
        this._runMoreTasks();
    }

    cancel() {
        for (const task of this.runningTasks)
            task.cancelled = true;
        this.backlogTasks = [];
        this.isPaused = false;
    }

    _queueNewTask(item, path) {
        const complete = (task) => {
            this.finishedTasks++;
            this.results.push(task.item);
            this._dispatchStatus("progress");

            const index = this.runningTasks.indexOf(task);
            if (index !== -1) {
                this.runningTasks.splice(index, 1);
                if (!this.isPaused) {
                    this._runMoreTasks();
                }
            } else {
                console.log('task not found', task);
            }
        };

        const loadOk = (task, data) => {
            if (task.cancelled) {
                complete(task);
                return;
            }
            this._runTest262Test(data, path,
                function pass() {
                    item.result = 'p';
                    complete(task);
                },
                function fail(msg) {
                    item.result = 'f';
                    item.msg = msg;
                    complete(task);
                },
                function skip(msg) {
                    item.result = 's';
                    item.msg = msg;
                    complete(task);
                });
        };

        const loadFailed = (task) => {
            item.result = 's';
            item.msg = 'Load failed.';
            complete(task);
        };

        const task = function(task) {
            const file = item.file;
            file.async("string").then((c) => loadOk(task, c), () => loadFailed(task));
        };
        task.item = item;
        item.path = path.slice(1).join("/");
        item.result = '';
        delete item.msg;

        this.backlogTasks.push(task);
    }

    _runMoreTasks() {
        // find new tasks (if any)
        const newTasks = [];
        while (this.runningTasks.length < CONFIG.maxRunningTasks) {
            const next = this.backlogTasks.shift();
            if (typeof next === "undefined")
                break;
            newTasks.push(next);
            this.runningTasks.push(next);
        }
        // if none running and no new, we're done
        if (!this.runningTasks.length && !newTasks.length) {
            this._dispatchStatus("end");
            return;
        }
        // dispatch (all async, so this returns immediately)
        for (const next of newTasks) {
            next(next);
        }
    }

    _installAPI(global) {
        const self = this;
        return global.$262 = {
            createRealm: function () {
                const iframe = global.document.createElement('iframe');
                iframe.src = self.iframeSrc;
                global.document.body.appendChild(iframe);
                return self._installAPI(iframe.contentWindow);
            },
            evalScript: function (src) {
                const script = global.document.createElement('script');
                script.text = src;
                global.document.body.appendChild(script);
            },
            detachArrayBuffer: function (buffer) {
                if (typeof postMessage !== 'function') {
                    throw new Error('No method available to detach an ArrayBuffer');
                } else {
                    postMessage(null, '*', [buffer]);
                    /*
                      See https://html.spec.whatwg.org/multipage/comms.html#dom-window-postmessage
                      which calls https://html.spec.whatwg.org/multipage/infrastructure.html#structuredclonewithtransfer
                      which calls https://html.spec.whatwg.org/multipage/infrastructure.html#transfer-abstract-op
                      which calls the DetachArrayBuffer abstract operation https://tc39.github.io/ecma262/#sec-detacharraybuffer
                    */
                }
            },
            global: global,
            IsHTMLDDA: global.document.all,
        };
    }

    _runSources(arg, done) {
        /*
        arg looks like this:
        {
          setup: string,
          source: string,
          isModule: boolean,
          isAsync: boolean,
          needsAPI: boolean,
          path: string,
        }
        */
        const self = this;
        const iframe = this.iframes.pop();

        const path = ['SYNTHETIC'].concat(arg.path);

        const listener = () => {
            iframe.removeEventListener('load', listener);
            let err = TestRunner.ERROR;
            let timeout;
            const w = iframe.contentWindow;
            let completed = false;

            if (arg.needsAPI) {
                this._installAPI(w);
            }

            w.$$testFinished = function () {
                if (completed) return;
                completed = true;
                if (timeout !== undefined) clearTimeout(timeout);
                self.iframes.push(iframe);
                done(err, w);
            };
            w.addEventListener('error', function (e) {
                e.preventDefault();
                err = e;
                w.$$testFinished();
            });
            if (arg.isAsync) {
                w.print = function (msg) {
                    if (err === TestRunner.ERROR && msg !== 'Test262:AsyncTestComplete') {
                        err = new w.Error('Error: unexpected message ' + msg);
                    }
                    w.$$testFinished();
                }
            }

            const setup = w.document.createElement('script');
            setup.text = arg.setup;
            w.document.body.appendChild(setup);

            if (self._serviceResolveSrcHandler)
                w.navigator.serviceWorker.addEventListener('message', self._serviceResolveSrcHandler);

            const script = w.document.createElement('script');
            if (arg.isModule) {
                script.src = path[path.length - 1];
                script.type = 'module';
            } else {
                script.text = arg.source;
            }
            w.document.body.appendChild(script);

            if (!arg.isAsync && !arg.isModule) { // For modules, our service worker appends this to the source; it would be better to do it this way in that case also, but there's some evaluation order issues.
                const finished = w.document.createElement('script');
                finished.text = '$$testFinished();';
                w.document.body.appendChild(finished);
            }
            if (!completed) {
                timeout = setTimeout(() => {
                    if (completed) return;
                    self.iframes.push(iframe);
                    done(err === TestRunner.ERROR ? TestRunner.NOCOMPLETE : err);
                }, CONFIG.scriptAbortTimeout);
            }
        };

        iframe.addEventListener('load', listener);

        iframe.src = (arg.isDynamic || arg.isModule)
            ? path.slice(0, path.length - 1).concat(['blank.html']).join('/')
            : this.iframeSrc; // Our service worker can't intercept requests when src = '', sadly.
    }

    _createErrCheck(negative, onPass, onFail) {
        const checkErrorType = (errorEvent, global, kind) => {
            if (typeof errorEvent.error === 'object') {
                return errorEvent.error instanceof global[kind];
            } else {
                return !!errorEvent.message.match(kind); // can give incorrect answers, but in practice this works pretty well.
            }
        }

        return function(err, w) {
            if (err === TestRunner.ERROR) {
                if (negative) {
                    onFail('Expecting ' + negative.phase + ' ' + negative.type + ', but no error was thrown.');
                } else {
                    onPass();
                }
            } else if (err === TestRunner.NOCOMPLETE) {
                onFail('Test timed out.');
            } else {
                if (negative) {
                    if (checkErrorType(err, w, negative.type)) {
                        onPass();
                    } else {
                        if (negative.phase === 'early' && err.message && err.message.match('NotEarlyError')) {
                            onFail('Expecting early ' + negative.type + ', but parsing succeeded without errors.');
                        } else {
                            onFail('Expecting ' + negative.phase + ' ' + negative.type + ', but got an error of another kind.');  // todo more precise complaints
                        }
                    }
                } else {
                    const loc = typeof err.lineno !== "undefined" ? err.lineno : "";
                    const msg = err.message.replace(/^uncaught.*?:/i, '');
                    onFail('Unexpected error: ' + msg + (loc?`\nat line ${loc}`:''));
                }
            }
        };
    }

    _parseFrontmatter(src) {
        const start = src.indexOf('/*---');
        const end = src.indexOf('---*/');
        if (start === -1 || end === -1) return null;

        let match, includes = [], flags = {}, negative = null;
        const frontmatter = src.substring(start + 5, end);

        match = frontmatter.match(/(?:^|\n)\s*includes:\s*\[([^\]]*)\]/);
        if (match) {
            includes = match[1].split(',').map(function f(s){return s.replace(/^\s+|\s+$/g, '');});
        } else {
            match = frontmatter.match(/(?:^|\n)\s*includes:\s*\n(\s+-.*\n)/);
            if (match) {
                includes = match[1].split(',').map(function f(s){return s.replace(/^[\s\-]+|\s+$/g, '');});
            }
        }

        match = frontmatter.match(/(?:^|\n)\s*flags:\s*\[([^\]]*)\]/);
        if (match) {
            match[1].split(',').map(function f(s){return s.replace(/^\s+|\s+$/g, '');}).forEach(function(flag) {
                switch (flag) {
                    case 'onlyStrict':
                        if (flags.strict) {
                            console.error('flag conflict', src);
                        }
                        flags.strict = 'always';
                        break;
                    case 'noStrict':
                        if (flags.strict) {
                            console.error('flag conflict');
                        }
                        flags.strict = 'never';
                        break;
                    case 'module':
                        flags.module = true;
                        break;
                    case 'raw':
                        flags.raw = true;
                        break;
                    case 'async':
                        flags.async = true;
                        break;
                    case 'generated':
                        break;
                    default:
                        console.error('unrecocognized flag: ' + flag, frontmatter);
                        break;
                }
            });
        }

        match = frontmatter.match(/(?:^|\n)\s*negative:/);
        if (match) {
            let phase, type;
            frontmatter.substr(match.index + 9).split('\n').forEach(function(line) {
                let match = line.match(/\s+phase:\s*(\S+)/);
                if (match) {
                    phase = match[1];
                }
                match = line.match(/\s+type:\s*(\S+)/);
                if (match) {
                    type = match[1];
                }
            });
            if (!phase || !type) return null;
            negative = {phase: phase, type: type};
        }

        return {
            includes: includes,
            flags: flags,
            negative: negative,
            isDynamic: /dynamic-import/.test(frontmatter)
        };
    }

    _runTest262Test(src, path, onPass, onFail, onSkip) {
        const meta = this._parseFrontmatter(src);
        if (!meta) {
            onSkip('Test runner couldn\'t parse frontmatter');
            return;
        }

        if (meta.negative && meta.negative.phase === 'early' && !meta.flags.raw) {
            src = 'throw new Error("NotEarlyError");\n' + src;
        }

        const includeSrcs = CONFIG.alwaysIncludeHarness.concat(meta.includes).map(include => this.harness[include]);
        const needsAPI = includeSrcs.some(src => src.match(/\$262\./)) || src.match(/\$262\./);

        const isAsync = meta.flags.async;
        if (isAsync) {
            includeSrcs.push(this.harness['doneprintHandle.js']);
        }

        // cleanup of global object. would be nice to also delete window.top, but we can't.
        if (!meta.flags.raw && src.match(/(?:^|[^A-Za-z0-9.'"\-])(name|length)/)) {
            includeSrcs.push('delete window.name;\ndelete window.length;');
        }

        const setup = includeSrcs.join(';\n');

        if ((includeSrcs + src).match(/\$262\.agent/)) {
            onSkip('Test runner does not yet support the agent API.'); // and won't until https://github.com/tc39/test262/issues/928 probably
            return;
        }

        const strict = src => '"use strict";\n' + src;

        if (meta.flags.module) {
            this._runSources({ setup: setup, source: src, isModule: true, isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, this._createErrCheck(meta.negative, onPass, onFail));
            return;
        }
        if (meta.flags.raw) {
            // Note: we cannot assert phase for these, so false positives are possible.
            this._runSources({ setup: setup, source: src, isModule: false, isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, this._createErrCheck(meta.negative, onPass, onFail));
            return;
        }
        if (meta.flags.strict) {
            this._runSources({ setup: setup, source: meta.flags.strict === 'always' ? strict(src) : src, isModule: false, isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, this._createErrCheck(meta.negative, onPass, onFail));
            return;
        }

        // run in both strict and non-strict
        this._runSources({ setup: setup, source: strict(src), isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, this._createErrCheck(meta.negative, () => {
            this._runSources({ setup: setup, source: src, isModule: false, isAsync: isAsync, needsAPI: needsAPI, path: path, isDynamic: meta.isDynamic }, this._createErrCheck(meta.negative, onPass, onFail));
        }, onFail));
    }
}

class GUI {
    fileEle = document.getElementById('fileLoader');
    loadStatus = document.getElementById('loadStatus');
    treeEle = document.getElementById('tests-tree');
    reportEle = document.getElementById('report');
    zip;
    selectedTests = [];
    startTime = 0;
    endTime = 0;

    constructor(runner) {
        this.testRunner = runner;

        // Register a service worker to handle module requests
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('message', this.onServiceResolveSrcMessage.bind(this));

            (async () => {
                // first, clear the worker list
                for (const reg of await navigator.serviceWorker.getRegistrations()) {
                    await reg.unregister();
                }
                // then register our worker for unpacking scripts
                try {
                    await navigator.serviceWorker.register('./js/worker.js');
                } catch (err) {
                    console.log('ServiceWorker registration failed: ', err);
                }
            })();
        }

        // attach events
        this.fileEle.value = ''; // so that the change event is still fired after reloads
        document.getElementById('loadLocal').addEventListener('click', () => {
            this.fileEle.click();
        });
        this.fileEle.addEventListener('change', this.onZipFileChanged.bind(this));

        document.getElementById('filter-include').addEventListener('click', this.onTestFilterInExcludeClick.bind(this, true));
        document.getElementById('filter-exclude').addEventListener('click', this.onTestFilterInExcludeClick.bind(this, false));
        document.getElementById('run-start').addEventListener('click', this.onRunStartClick.bind(this));
        document.getElementById('run-pause').addEventListener('click', this.onRunPauseClick.bind(this));
        document.getElementById('run-cancel').addEventListener('click', this.onRunCancelClick.bind(this));
        document.getElementById('report-update').addEventListener('click', this.onReportUpdateClick.bind(this));
        document.getElementById('report-copy').addEventListener('click', this.onReportCopyClick.bind(this));

        this.testRunner.setServiceResolveSrcHandler(this.onServiceResolveSrcMessage.bind(this));
        this.testRunner.setStatusHandler(this.onRunStatus.bind(this));

        this.setTab('file', true);
    }

    // Global

    setTab(tabName, visible) {
        document.getElementById('tab-' + tabName).disabled = !visible;
    }

    onServiceResolveSrcMessage(e) {
        const port = e.ports[0];
        let path = e.data.split('/');
        path = path.slice(path.lastIndexOf('test') + 1);
        let head = this.zip.root.files.test;
        for (let i = 0; i < path.length; ++i) {
            if (typeof head !== 'object' || head.type !== 'dir') {
                port.postMessage({ success: false });
                return;
            }
            head = head.files[path[i]];
        }
        if (typeof head !== 'object' || head.type !== 'file') {
            port.postMessage({ success: false });
            return;
        }
        head.file.async('string').then(function(c) {
            port.postMessage({ success: true, data: c });
        }, function(e) {
            port.postMessage({ success: false });
        });
    }

    // File

    async _loadFromZip(file) {
        this.treeEle.textContent = 'Tests:';

        let t = Date.now();
        const zip = await JSZip.loadAsync(file);
        console.log(`Reading Zip: ${Date.now()-t} ms`);
        t = Date.now();
        this.zip = new ZipFile(zip);
        console.log(`Parsing Tree: ${Date.now()-t} ms`);
        const rootFiles = this.zip.root.files;

        const harnessNames = Object.keys(rootFiles.harness.files);
        const harness = {};
        for (const hn of harnessNames) {
            harness[hn] = await this.zip.extract(['harness', hn]);
        }
        this.testRunner.setHarness(harness);

        this.treeEle.totalCount = rootFiles.test.count;
        t = Date.now();
        this._renderTree(rootFiles.test.files, this.treeEle, ['test'], false);
        console.log(`Rendering Tree: ${Date.now()-t} ms`);
    }
    async onZipFileChanged() {
        const file = this.fileEle.files[0];
        if (!file) {
            return;
        }

        const fn = file.name.replace(/</g, '&lt;');
        this.loadStatus.innerHTML = 'Reading <kbd>' + fn + '</kbd>...';

        try {
            await this._loadFromZip(file);
            this.loadStatus.innerHTML = 'Loaded <kbd>' + fn + '</kbd>.';
            this._updateSelectedTests();
            this.setTab('setup', true);
        } catch (e) {
            this.loadStatus.textContent = e;
        }
        this.fileEle.value = '';
    }

    // Setup

    _renderTree(tree, container, path, hide) {
        const list = document.createElement('ul');
        const fileNames = Object.keys(tree);
        fileNames.sort();
        for (const fn of fileNames) {
            const item = tree[fn];
            const li = list.appendChild(html`
                <li .testItem=${item}
                    .path=${path.concat([item.name])}>
                    <div class="test-row">
                        <span><input type="checkbox" /> ${item.name}</span>
                    </div>
                </li>
            `);
            const row = li.querySelector('div');
            li.check = row.querySelector('input');

            if (item.type === 'file') {
                li.className = 'tests-file';
                row.appendChild(html`<span><a href="#" @click="${this.onViewSource.bind(this, item)}">Src</a></span>`);
            } else {
                li.className = 'tests-folder';
                li.totalCount = item.count;
                this._renderTree(item.files, li, li.path, true);
                li.selStatus = row.appendChild(document.createElement('span'));
                li.addEventListener('click', this.onTestListItemClicked.bind(this, li));
                li.check.addEventListener('change', this.onTestListFolderChecked.bind(this, li));
            }
        }
        container.classList.toggle('closed', !!hide);
        container.appendChild(list);
    }

    _setRecursiveChecked(li) {
        const check = li.check;
        for (const sub of li.querySelectorAll(':scope>ul>li')) {
            sub.check.checked = check.checked;
            this._setRecursiveChecked(sub);
        }
    }

    _updateSelectedTests() {
        const totalList = [];

        const descendTree = (parentLi) => {
            let recTotal = 0;
            let recEnabled = 0;
            for (const sub of parentLi.querySelectorAll(':scope>ul>li')) {
                const item = sub.testItem;
                if (item.type === 'file') {
                    recTotal++;
                    if (sub.check.checked) {
                        recEnabled ++;
                        totalList.push(sub);
                    }
                } else {
                    descendTree(sub);
                    recTotal += sub.totalCount;
                    recEnabled += sub.enabledCount;
                    sub.selStatus.textContent = `${sub.enabledCount} / ${sub.totalCount}`;
                }
            }
            parentLi.totalCount = recTotal;
            parentLi.enabledCount = recEnabled;
        };

        descendTree(this.treeEle);
        document.getElementById('run-start').disabled = !totalList.length;
        this.selectedTests = totalList;
    }

    onTestListItemClicked(li, e) {
        if (e.target !== li) return;
        e.stopPropagation();
        li.classList.toggle('closed');
    }

    onTestListFolderChecked(li, e) {
        this._setRecursiveChecked(li);
        this._updateSelectedTests();
    }

    onTestFilterInExcludeClick(doInclude, e) {
        const expr = new RegExp(document.getElementById('test-filter-regex').value, 'i');
        for (const li of this.treeEle.querySelectorAll(':scope * li')) {
            const item = li.testItem;
            if (expr.test(item.name)) {
                li.check.checked = doInclude;
                this._setRecursiveChecked(li);
            }
        }
        this._updateSelectedTests();
    }

    async onViewSource(item) {
        try {
            const data = await item.file.async("string");
            const w = window.open(this.testRunner.iframeSrc);
            const pre = w.document.body.appendChild(w.document.createElement('pre'));
            pre.textContent = data;
        } catch (e) {
            console.error("Error loading file. This shouldn't happen...", e);
        }
    };

    onRunStartClick() {
        this.testRunner.startNew(this.selectedTests);
    }

    // Status

    onRunPauseClick(evt) {
        if (this.testRunner.isPaused) {
            this.testRunner.resume();
        } else {
            this.testRunner.pause();
        }
    }

    onRunCancelClick() {
        this.testRunner.cancel();
    }

    onRunStatus(sender, status) {
        const pauseButton = document.getElementById('run-pause');
        const statusText = document.getElementById('status-text');
        switch (status) {
            case "begin":
                this.setTab('file', false);
                this.setTab('setup', false);
                this.setTab('status', true);
                this.setTab('report', true);
                statusText.innerText = `Launching...`;
                this.startTime = Date.now();
                break;
            case "progress":
                statusText.innerText = `Running... ${sender.finishedTasks} / ${sender.totalTasks}`;
                if (!this._reportUpdateLimiter) {
                    this._reportUpdateLimiter = setTimeout(() => {
                        this._reportUpdateLimiter = 0;
                        this._updateReport();
                    }, CONFIG.reportUpdateInterval);
                }
                break;
            case "pause":
                pauseButton.value = 'Resume';
                pauseButton.className = 'btn btn-success btn-lg';
                break;
            case "resume":
                pauseButton.value = 'Pause';
                pauseButton.className = 'btn btn-primary btn-lg';
                break;
            case "end":
                statusText.innerText = `Done. Ran ${sender.finishedTasks} / ${sender.totalTasks}`;
                this.endTime = Date.now();
                this.setTab('file', true);
                this.setTab('setup', true);
                this.setTab('status', false);
                this._updateReport();
                break;
            default:
                console.error("Unknown status: ", status);
        }
    }

    // Report

    _updateReport(e) {
        const includePassed = document.getElementById('report-include-passed').checked;
        const includeFailed = document.getElementById('report-include-failed').checked;
        const includeSkipped = document.getElementById('report-include-skipped').checked;
        const groupByResult = document.getElementById('report-group-pass').checked;

        const lines = [];
        let endTime = this.endTime;
        if (this.testRunner.isRunning) {
            lines.push(`======== Running, preliminary results ========`)
            endTime = Date.now();
        }
        const runSeconds = (endTime - this.startTime) / 1000;
        lines.push(`   Start time : ${(new Date(this.startTime)).toISOString()}`)
        lines.push(`Total runtime : ${runSeconds.toFixed(0)} s`);
        if (this.testRunner.isRunning) {
            const expTotal = runSeconds / (this.testRunner.finishedTasks / this.testRunner.totalTasks);
            lines.push(`          ETA : ${(expTotal-runSeconds).toFixed(0)} s`);
        }
        lines.push(`    Ran Tests : ${this.testRunner.finishedTasks} / ${this.testRunner.totalTasks}`);

        let passed = 0;
        let failed = 0;
        let skipped = 0;
        const display = [];

        for (const item of this.testRunner.results) {
            switch (item.result) {
                case "p":
                    passed++;
                    if (includePassed)
                        display.push(item);
                    break;
                case "f":
                    failed++;
                    if (includeFailed)
                        display.push(item);
                    break;
                case "s":
                    skipped++;
                    if (includeSkipped)
                        display.push(item);
                    break;
            }
        }

        lines.push(`       Passed : ${passed}`);
        lines.push(`       Failed : ${failed}`);
        lines.push(`      Skipped : ${skipped}`);
        this.reportEle.innerText = lines.join('\n');

        if (display.length) {
            const sortByPath = (a, b) => a.path.localeCompare(b.path);
            let compareFn = sortByPath;
            if (groupByResult) {
                compareFn = (a, b) => {
                    const ar = "pfs".indexOf(a.result);
                    const br = "pfs".indexOf(b.result);
                    if (ar < br)
                        return -1;
                    if (br > ar)
                        return 1;
                    return sortByPath(a, b);
                }
            }

            display.sort(compareFn);
            const statusDisplayNames = {
                'p': 'PASSED',
                'f': 'FAILED',
                's': '(Skipped)'
            }
            const indentEveryLine = (str) => {
                return str.trim().split('\n').map(l => '    ' + l).join("\n");
            }
            // add the rest as textNodes to insert source links
            const texts = [];
            texts.push(document.createTextNode("\n"));
            for (const item of display) {
                const p = item.path;
                texts.push(html`<a href="#" @click=${this.onViewSource.bind(this, item)}>${p}</a>\n`);
                texts.push(document.createTextNode(`${" ".repeat(100-p.length)}: ${statusDisplayNames[item.result]}\n`));
                if (item.msg) {
                    texts.push(document.createTextNode(indentEveryLine(item.msg) + "\n"));
                }
            }
            this.reportEle.append(...texts);
        }
    }

    onReportUpdateClick() {
        this._updateReport();
    }

    async onReportCopyClick() {
        const text = this.reportEle.innerText;
        try {
            await navigator.clipboard.writeText(text);
        } catch (error) {
            console.error(error.message);
        }
    }
}

window.addEventListener('load', () => {
    const runner = new TestRunner();
    new GUI(runner);
})