'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

class FakeElement {
    constructor(id = '') {
        this.id = id;
        this.hidden = id.endsWith('-modal');
        this.disabled = false;
        this.value = '';
        this.textContent = '';
        this.dataset = {};
        this.attributes = {};
        this.listeners = new Map();
        this.classes = new Set();
        this.classList = {
            add: name => this.classes.add(name),
            remove: name => this.classes.delete(name),
            contains: name => this.classes.has(name),
            toggle: (name, force) => {
                const enabled = force === undefined ? !this.classes.has(name) : force;
                if (enabled) this.classes.add(name);
                else this.classes.delete(name);
                return enabled;
            }
        };
        this.capturedPointers = new Set();
    }

    addEventListener(type, callback) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type).push(callback);
    }

    dispatch(type, properties = {}) {
        const event = {
            type,
            target: this,
            currentTarget: this,
            preventDefault() { this.defaultPrevented = true; },
            ...properties
        };
        for (const callback of this.listeners.get(type) || []) callback(event);
        return event;
    }

    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    closest() { return null; }
    focus() {}
    setPointerCapture(id) { this.capturedPointers.add(id); }
    hasPointerCapture(id) { return this.capturedPointers.has(id); }
    releasePointerCapture(id) { this.capturedPointers.delete(id); }
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function makeController({ write, fastTransmissionTimeout = false } = {}) {
    const elements = new Map();
    const buttons = ['up', 'down', 'left', 'right', 'a', 'b', 'c', 'd'].map(action => {
        const button = new FakeElement('control-' + action);
        button.dataset.action = action;
        return button;
    });
    const window = new FakeElement('window');
    const document = new FakeElement('document');
    document.hidden = false;
    document.body = { dataset: {} };
    document.getElementById = id => {
        if (!elements.has(id)) elements.set(id, new FakeElement(id));
        return elements.get(id);
    };
    document.querySelectorAll = selector => selector === '.ctrl-btn' ? buttons : [];

    const writes = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const writer = async bytes => {
        const command = new TextDecoder().decode(bytes).trim();
        writes.push(command);
        inFlight++;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        try {
            if (write) await write(command);
        } finally {
            inFlight--;
        }
    };
    const deviceListeners = new Map();
    const device = {
        gatt: {
            connected: false,
            async connect() {
                this.connected = true;
                return { async getPrimaryService() { return service; } };
            },
            disconnect() { this.connected = false; }
        },
        addEventListener(type, callback) {
            if (!deviceListeners.has(type)) deviceListeners.set(type, []);
            deviceListeners.get(type).push(callback);
        },
        emit(type) { for (const callback of deviceListeners.get(type) || []) callback(); }
    };
    const characteristic = {
        uuid: '6e400003-b5a3-f393-e0a9-e50e24dcca9e',
        properties: { write: true },
        writeValueWithResponse: writer
    };
    const service = { async getCharacteristics() { return [characteristic]; } };
    const navigator = { bluetooth: { async requestDevice() { return device; } } };
    const localStorage = { getItem() { return null; }, setItem() {} };
    const context = {
        document,
        window,
        navigator,
        localStorage,
        location: { protocol: 'https:' },
        TextEncoder,
        TextDecoder,
        setTimeout: (callback, delay, ...args) => setTimeout(callback, fastTransmissionTimeout && delay === 1500 ? 5 : delay, ...args),
        clearTimeout,
        console: { error() {} }
    };
    context.globalThis = context;
    vm.runInNewContext(appSource + '\n;globalThis.__controller = { connect, disconnect, emergencyStop };', context, { filename: 'app.js' });

    return {
        buttons,
        device,
        document,
        elements,
        get maximumInFlight() { return maximumInFlight; },
        writes,
        window,
        async connect() { await context.__controller.connect(); },
        async key(type, code, extra = {}) {
            await window.dispatch(type, { code, key: code, ...extra });
        },
        async pointer(button, type, pointerId = 1) {
            await button.dispatch(type, { pointerId, button: 0 });
        },
        async disconnectExternally() {
            device.gatt.connected = false;
            device.emit('gattserverdisconnected');
        }
    };
}

async function waitFor(predicate, message) {
    for (let attempt = 0; attempt < 100; attempt++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 0));
    }
    assert.fail(message || 'condition did not become true');
}

test('releasing a direction key sends STOP', async () => {
    const controller = makeController();
    await controller.connect();
    await controller.key('keydown', 'ArrowUp');
    await controller.key('keyup', 'ArrowUp');
    await waitFor(() => controller.writes.length === 3, 'expected connect STOP, UP, and release STOP');
    assert.deepEqual(controller.writes, ['STOP', 'UP', 'STOP']);
});

test('overlapping directions restore the last held direction, then stop', async () => {
    const controller = makeController();
    await controller.connect();
    await controller.key('keydown', 'ArrowUp');
    await waitFor(() => controller.writes.includes('UP'));
    await controller.key('keydown', 'ArrowRight');
    await waitFor(() => controller.writes.includes('RIGHT'));
    await controller.key('keyup', 'ArrowRight');
    await waitFor(() => controller.writes.filter(command => command === 'UP').length === 2);
    await controller.key('keyup', 'ArrowUp');
    await waitFor(() => controller.writes.length === 5);
    assert.deepEqual(controller.writes, ['STOP', 'UP', 'RIGHT', 'UP', 'STOP']);
});

test('pointer cancellation releases a touch control and stops once', async () => {
    const controller = makeController();
    await controller.connect();
    const up = controller.buttons.find(button => button.dataset.action === 'up');
    await controller.pointer(up, 'pointerdown');
    await controller.pointer(up, 'pointercancel');
    await controller.pointer(up, 'lostpointercapture');
    await waitFor(() => controller.writes.length === 3);
    assert.deepEqual(controller.writes, ['STOP', 'UP', 'STOP']);
});

test('browser blur clears a held key and sends STOP', async () => {
    const controller = makeController();
    await controller.connect();
    await controller.key('keydown', 'ArrowLeft');
    await controller.window.dispatch('blur');
    await controller.key('keyup', 'ArrowLeft');
    await waitFor(() => controller.writes.length === 3);
    assert.deepEqual(controller.writes, ['STOP', 'LEFT', 'STOP']);
    assert.equal(controller.elements.get('input-status').textContent, '정지 · 방향키나 화면 버튼을 누르면 움직여요');
});

test('STOP drops queued movement during a delayed GATT write and writes remain serial', async () => {
    const firstWrite = deferred();
    const controller = makeController({ write: command => command === 'UP' ? firstWrite.promise : undefined });
    await controller.connect();
    await controller.key('keydown', 'ArrowUp');
    await waitFor(() => controller.writes.includes('UP'));
    await controller.key('keydown', 'ArrowRight');
    await controller.window.dispatch('blur');
    firstWrite.resolve();
    await waitFor(() => controller.writes.includes('STOP') && controller.writes.length === 3);
    assert.deepEqual(controller.writes, ['STOP', 'UP', 'STOP']);
    assert.equal(controller.maximumInFlight, 1);
});

test('a Bluetooth disconnect clears inputs and queued commands', async () => {
    const pending = deferred();
    const controller = makeController({ write: command => command === 'UP' ? pending.promise : undefined });
    await controller.connect();
    await controller.key('keydown', 'ArrowUp');
    await waitFor(() => controller.writes.includes('UP'));
    await controller.key('keydown', 'ArrowRight');
    await controller.disconnectExternally();
    pending.resolve();
    await waitFor(() => controller.elements.get('status-text').textContent.includes('연결이 끊어졌습니다'));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(controller.writes, ['STOP', 'UP']);
    assert.equal(controller.elements.get('input-status').textContent, '정지 · 방향키나 화면 버튼을 누르면 움직여요');
});

test('a timed-out GATT write disconnects instead of overlapping an uncertain STOP write', async () => {
    const controller = makeController({ write: command => command === 'UP' ? new Promise(() => {}): undefined, fastTransmissionTimeout: true });
    await controller.connect();
    await controller.key('keydown', 'ArrowUp');
    await waitFor(() => controller.elements.get('status-text').textContent.includes('전송에 문제가 생겨'));
    assert.deepEqual(controller.writes, ['STOP', 'UP']);
    assert.equal(controller.device.gatt.connected, false);
});

