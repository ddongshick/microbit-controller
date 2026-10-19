'use strict';

const UART_SERVICE_UUID = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const UART_RX_UUID = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const defaultCommands = { up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', a: 'A', b: 'B', c: 'C', d: 'D', stop: 'STOP' };
const defaultTuning = { F_P0: 180, F_P1: 0, B_P0: 0, B_P1: 180, L_P0: 0, L_P1: 0, R_P0: 180, R_P1: 180, A_P2: 180, B_P2: 0, C_P2: 90, D_P2: 90 };
const directions = new Set(['up', 'down', 'left', 'right']);
const keyActions = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyA: 'a', KeyB: 'b', KeyC: 'c', KeyD: 'd' };
const actionNames = { up: '직진 ↑', down: '후진 ↓', left: '좌회전 ←', right: '우회전 →', a: 'A', b: 'B', c: 'C', d: 'D' };
const $ = id => document.getElementById(id);
const ctrlBtns = Array.from(document.querySelectorAll('.ctrl-btn'));
const motorSliders = Array.from(document.querySelectorAll('.motor-slider'));
let currentCommands = { ...defaultCommands };
let currentTuning = { ...defaultTuning };
let bluetoothDevice = null;
let link = null;
let connecting = false;
let disconnecting = false;
let connectionVersion = 0;
let pressOrder = 0;
let toastTimer;
const heldInputs = new Map();

function showToast(message = '설정을 저장했습니다.') {
    $('toast').textContent = message;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2500);
}
function validCommand(value) {
    return typeof value === 'string' && !!value.trim() && !/[\x00-\x1f\x7f]/.test(value) && new TextEncoder().encode(value + '\n').length <= 20;
}
function loadSettings() {
    try {
        const saved = JSON.parse(localStorage.getItem('microbit-car-commands-v5') || 'null');
        if (saved && typeof saved === 'object') {
            for (const key of Object.keys(defaultCommands)) if (validCommand(saved[key])) currentCommands[key] = saved[key];
            if (Object.keys(defaultCommands).some(key => key !== 'stop' && currentCommands[key] === currentCommands.stop)) currentCommands = { ...defaultCommands };
        }
    } catch (_) { showToast('저장된 명령을 읽지 못해 기본 명령으로 시작합니다.'); }
    try {
        const saved = JSON.parse(localStorage.getItem('microbit-car-tuning-v1') || 'null');
        if (saved && typeof saved === 'object') {
            for (const key of Object.keys(defaultTuning)) {
                const value = Number(saved[key]);
                if (saved[key] !== undefined && Number.isInteger(value) && value >= 0 && value <= 180) currentTuning[key] = value;
            }
        }
    } catch (_) { /* Storage can be unavailable for local files; controls still work. */ }
    for (const key of Object.keys(defaultCommands)) $('cmd-' + key).value = currentCommands[key];
    for (const slider of motorSliders) {
        slider.value = currentTuning[slider.dataset.var];
        $('val_' + slider.id.replace('var_', '')).textContent = slider.value;
    }
}
function persistSettings(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { showToast('이번 실행에는 적용했습니다. 브라우저에서 설정 저장을 허용하지 않았습니다.'); return false; }
}
async function saveSettings() {
    if ($('btn-save-settings').disabled) return;
    const next = {};
    for (const key of Object.keys(defaultCommands)) {
        const value = $('cmd-' + key).value || defaultCommands[key];
        if (!validCommand(value)) { showToast('명령은 줄바꿈 없이 짧게 입력해 주세요.'); return; }
        next[key] = value;
    }
    if (Object.keys(next).some(key => key !== 'stop' && next[key] === next.stop)) { showToast('정지 명령은 이동·보조 버튼의 명령과 달라야 합니다.'); return; }
    $('btn-save-settings').disabled = true;
    try {
        // Finish the old STOP before applying a corrected STOP spelling.
        const previousStop = currentCommands.stop;
        await emergencyStop();
        currentCommands = next;
        if (next.stop !== previousStop) await emergencyStop();
        const saved = persistSettings('microbit-car-commands-v5', currentCommands);
        closeModal('settings-modal');
        if (saved) showToast();
    } finally { $('btn-save-settings').disabled = false; }
}
function modalOpen() { return !$('settings-modal').hidden || !$('tuning-modal').hidden; }
function editable(target) {
    return !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || !!target.closest?.('[contenteditable="true"]'));
}
function latestDirection() {
    let latest = null;
    for (const input of heldInputs.values()) if (directions.has(input.action) && (!latest || input.order > latest.order)) latest = input;
    return latest ? latest.action : null;
}
function paintInputs() {
    const actions = new Set(Array.from(heldInputs.values(), input => input.action));
    for (const button of ctrlBtns) {
        const active = actions.has(button.dataset.action);
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    }
    const direction = latestDirection();
    const auxiliary = Array.from(actions).filter(action => !directions.has(action));
    $('input-status').textContent = direction ? actionNames[direction] + ' · 누르는 동안 이동'
        : auxiliary.length ? auxiliary.map(action => actionNames[action]).join(' + ') + ' 보조 조작 · 바퀴 방향 입력 없음'
        : '정지 · 방향키나 화면 버튼을 누르면 움직여요';
}
function canControl() { return !!link && !link.closed && !connecting && !disconnecting && !modalOpen(); }
function pressInput(source, action, button, pointerId) {
    if (!canControl() || heldInputs.has(source)) return false;
    const previous = latestDirection();
    const alreadyHeld = Array.from(heldInputs.values()).some(input => input.action === action);
    heldInputs.set(source, { action, order: ++pressOrder, button, pointerId });
    paintInputs();
    if (directions.has(action)) {
        if (latestDirection() !== previous) enqueue(currentCommands[action], 'drive');
    } else if (!alreadyHeld) enqueue(currentCommands[action], 'aux');
    return true;
}
function releaseInput(source) {
    const input = heldInputs.get(source);
    if (!input) return;
    const previous = latestDirection();
    heldInputs.delete(source);
    // Remove ownership before releasing capture: lostpointercapture may fire synchronously.
    if (input.pointerId !== undefined) {
        try { if (input.button.hasPointerCapture?.(input.pointerId)) input.button.releasePointerCapture(input.pointerId); } catch (_) {}
    }
    const next = latestDirection();
    paintInputs();
    if (directions.has(input.action)) {
        if (previous !== next) next ? enqueue(currentCommands[next], 'drive') : enqueue(currentCommands.stop, 'stop');
    } else {
        const stillHeld = Array.from(heldInputs.values()).some(held => held.action === input.action);
        if (!stillHeld) next ? enqueue(currentCommands[next], 'drive') : enqueue(currentCommands.stop, 'stop');
    }
}
function clearInputs() {
    const previous = Array.from(heldInputs.values());
    heldInputs.clear();
    for (const input of previous) if (input.pointerId !== undefined) {
        try { if (input.button.hasPointerCapture?.(input.pointerId)) input.button.releasePointerCapture(input.pointerId); } catch (_) {}
    }
    paintInputs();
}
function emergencyStop() {
    clearInputs();
    return enqueue(currentCommands.stop, 'stop');
}
function openModal(id) {
    emergencyStop();
    const panel = $(id);
    panel.hidden = false;
    panel.classList.add('show');
    panel.focus?.();
}
function closeModal(id) {
    $(id).classList.remove('show');
    $(id).hidden = true;
}

// One GATT write at a time. STOP removes unsent movement before it is put first.
function enqueue(data, kind, key) {
    const context = link;
    if (!context || context.closed) return Promise.resolve(false);
    if (!validCommand(data)) return Promise.resolve(false);
    if (kind === 'stop') {
        const retained = [];
        for (const item of context.queue) {
            if (item.kind === 'drive' || item.kind === 'aux') item.resolve(false);
            else retained.push(item);
        }
        context.queue = retained;
        const existing = context.queue.find(item => item.kind === 'stop');
        if (existing) return existing.promise;
    } else if (kind === 'drive' || kind === 'tuning') {
        context.queue = context.queue.filter(item => {
            const replace = item.kind === kind && (kind === 'drive' || item.key === key);
            if (replace) item.resolve(false);
            return !replace;
        });
    } else if (kind === 'aux') {
        context.queue = context.queue.filter(item => { if (item.kind === 'aux') { item.resolve(false); return false; } return true; });
    }
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    const item = { data, kind, key, promise, resolve };
    if (kind === 'stop') context.queue.unshift(item);
    else context.queue.push(item);
    void pump(context);
    return promise;
}
function writeWithTimeout(writer, data, timeout = 1500) {
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => { const error = new Error('전송 응답이 지연됩니다.'); error.name = 'TransmissionTimeout'; reject(error); }, timeout);
    });
    const write = Promise.resolve().then(() => writer(new TextEncoder().encode(data + '\n')));
    return Promise.race([write, timeoutPromise]).finally(() => clearTimeout(timer));
}
async function pump(context) {
    if (context.running || context.closed) return;
    context.running = true;
    try {
        while (link === context && !context.closed && context.queue.length) {
            const item = context.queue.shift();
            try {
                await writeWithTimeout(context.writer, item.data);
                if (link !== context || context.closed) { item.resolve(false); break; }
                $('status-text').textContent = item.kind === 'stop' ? '연결됨 · 정지 신호 전송 완료' : '연결됨 · ' + item.data + ' 전송';
                item.resolve(true);
            } catch (error) {
                item.resolve(false);
                if (link !== context || context.closed) break;
                clearInputs();
                for (const queued of context.queue) queued.resolve(false);
                context.queue = [];
                // A settled failed write permits one best-effort STOP. A timed-out write is still
                // pending in the browser, so disconnect instead of issuing overlapping operations.
                context.closed = true;
                if (error.name !== 'TransmissionTimeout' && context.device.gatt.connected) {
                    try { await writeWithTimeout(context.writer, currentCommands.stop, 700); } catch (_) {}
                }
                if (link === context) teardown('전송에 문제가 생겨 연결을 해제했습니다. 로봇 상태를 확인하고 다시 연결해 주세요.');
                break;
            }
        }
    } finally { context.running = false; }
}
function updateConnectionUI(message) {
    $('btn-connect').disabled = connecting || disconnecting;
    $('btn-connect').textContent = connecting ? '연결 중...' : disconnecting ? '정지 후 연결 해제 중...' : link && !link.closed ? '연결 해제' : '블루투스 연결';
    $('btn-connect').classList.toggle('connected', !!link && !link.closed);
    $('status-indicator').classList.toggle('connected', !!link && !link.closed);
    if (message) $('status-text').textContent = message;
}
function teardown(message = '연결이 끊어졌습니다. 다시 연결해 주세요.') {
    ++connectionVersion;
    const previous = link;
    const device = bluetoothDevice;
    link = null;
    bluetoothDevice = null;
    connecting = false;
    disconnecting = false;
    clearInputs();
    if (previous) {
        previous.closed = true;
        for (const item of previous.queue) item.resolve(false);
        previous.queue = [];
    }
    if (device && device.gatt.connected) device.gatt.disconnect();
    updateConnectionUI(message);
}
function availableWriters(characteristic) {
    const methods = [];
    const properties = characteristic.properties;
    if (properties.write && typeof characteristic.writeValueWithResponse === 'function') methods.push(data => characteristic.writeValueWithResponse(data));
    if (properties.writeWithoutResponse && typeof characteristic.writeValueWithoutResponse === 'function') methods.push(data => characteristic.writeValueWithoutResponse(data));
    if (!methods.length && (properties.write || properties.writeWithoutResponse) && typeof characteristic.writeValue === 'function') methods.push(data => characteristic.writeValue(data));
    return methods;
}
async function connect() {
    if (connecting || disconnecting || link) return;
    if (!navigator.bluetooth || !navigator.bluetooth.requestDevice) {
        updateConnectionUI('이 브라우저에서 블루투스를 사용할 수 없습니다. Chrome 또는 Edge에서 열어 주세요.');
        return;
    }
    connecting = true;
    clearInputs();
    const version = ++connectionVersion;
    updateConnectionUI('마이크로비트를 선택해 주세요.');
    let device;
    try {
        device = await navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'BBC micro:bit' }], optionalServices: [UART_SERVICE_UUID] });
        if (version !== connectionVersion) return;
        bluetoothDevice = device;
        device.addEventListener('gattserverdisconnected', () => { if (bluetoothDevice === device) teardown(); });
        const server = await device.gatt.connect();
        if (version !== connectionVersion) { if (device.gatt.connected) device.gatt.disconnect(); return; }
        const service = await server.getPrimaryService(UART_SERVICE_UUID);
        const characteristics = await service.getCharacteristics();
        if (version !== connectionVersion) return;
        const candidates = [...characteristics].sort((a, b) => Number(b.uuid === UART_RX_UUID) - Number(a.uuid === UART_RX_UUID));
        let writer = null;
        for (const characteristic of candidates) {
            for (const candidate of availableWriters(characteristic)) {
                try {
                    // Probe with an idempotent STOP, never a movement command or empty message.
                    await writeWithTimeout(candidate, currentCommands.stop);
                    writer = candidate;
                    break;
                } catch (error) { if (error.name === 'TransmissionTimeout') throw error; }
            }
            if (writer) break;
        }
        if (version !== connectionVersion) return;
        if (!writer) throw new Error('마이크로비트의 UART 수신 기능을 확인해 주세요.');
        link = { device, writer, queue: [], running: false, closed: false };
        connecting = false;
        clearInputs();
        updateConnectionUI('연결됨 · 방향키 또는 화면 버튼으로 조종하세요.');
    } catch (error) {
        if (version !== connectionVersion) return;
        console.error(error);
        teardown(error.name === 'NotFoundError' ? '연결을 취소했습니다. 다시 연결할 수 있습니다.' : '연결 실패: ' + error.message);
    } finally {
        if (version === connectionVersion) { connecting = false; updateConnectionUI(); }
    }
}
async function disconnect() {
    if (!link || disconnecting) return;
    disconnecting = true;
    const previous = link;
    updateConnectionUI();
    await emergencyStop();
    if (link === previous) teardown('연결을 해제했습니다.');
}
async function toggleBluetooth() { if (link) await disconnect(); else await connect(); }

function setupEventListeners() {
    $('btn-connect').addEventListener('click', toggleBluetooth);
    $('btn-stop').addEventListener('click', emergencyStop);
    $('btn-stop').addEventListener('pointerdown', event => { event.preventDefault(); emergencyStop(); });
    $('btn-settings').addEventListener('click', () => openModal('settings-modal'));
    $('btn-option').addEventListener('click', () => openModal('tuning-modal'));
    $('btn-close-modal').addEventListener('click', () => closeModal('settings-modal'));
    $('btn-close-tuning').addEventListener('click', () => closeModal('tuning-modal'));
    $('btn-save-settings').addEventListener('click', saveSettings);
    for (const id of ['settings-modal', 'tuning-modal']) $(id).addEventListener('click', event => { if (event.target === $(id)) closeModal(id); });
    for (const slider of motorSliders) {
        slider.addEventListener('input', () => { $('val_' + slider.id.replace('var_', '')).textContent = slider.value; });
        slider.addEventListener('change', () => {
            const key = slider.dataset.var;
            const value = Number(slider.value);
            if (!(key in defaultTuning) || !Number.isInteger(value) || value < 0 || value > 180) return;
            currentTuning[key] = value;
            persistSettings('microbit-car-tuning-v1', currentTuning);
            if (link) enqueue('VAR:' + key + ':' + value, 'tuning', key);
            else showToast('값을 저장했습니다. 로봇에 적용하려면 연결 후 슬라이더를 조절해 주세요.');
        });
    }
    for (const button of ctrlBtns) {
        button.addEventListener('pointerdown', event => {
            if (event.button !== undefined && event.button !== 0) return;
            event.preventDefault();
            if (!canControl()) { if (!modalOpen()) showToast('먼저 마이크로비트를 연결해 주세요.'); return; }
            if (pressInput('pointer:' + event.pointerId, button.dataset.action, button, event.pointerId)) {
                try { button.setPointerCapture(event.pointerId); } catch (_) { /* Window release listeners still apply. */ }
            }
        });
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture', 'pointerleave']) {
            button.addEventListener(type, event => { releaseInput('pointer:' + event.pointerId); });
        }
        button.addEventListener('contextmenu', event => { event.preventDefault(); emergencyStop(); });
    }
    for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, event => releaseInput('pointer:' + event.pointerId));
    window.addEventListener('keydown', event => {
        const code = event.code || event.key;
        if (code === 'Escape') {
            event.preventDefault(); emergencyStop(); closeModal('settings-modal'); closeModal('tuning-modal'); return;
        }
        if (['AltLeft', 'AltRight', 'ControlLeft', 'ControlRight', 'MetaLeft', 'MetaRight'].includes(code)) { emergencyStop(); return; }
        if (event.isComposing || editable(event.target) || modalOpen() || event.ctrlKey || event.metaKey || event.altKey) return;
        if (code === 'Space' || event.key === ' ') { event.preventDefault(); if (!event.repeat) emergencyStop(); return; }
        const focusedControl = event.target?.closest?.('.ctrl-btn');
        const action = keyActions[code] || (code === 'Enter' && focusedControl ? focusedControl.dataset.action : null);
        if (!action) return;
        event.preventDefault();
        if (event.repeat || heldInputs.has('key:' + code)) return;
        if (!canControl()) { showToast('먼저 마이크로비트를 연결해 주세요.'); return; }
        pressInput('key:' + code, action);
    });
    // Always release owned keys, even if focus/modifier/modal state changed after keydown.
    window.addEventListener('keyup', event => {
        const source = 'key:' + (event.code || event.key);
        if (heldInputs.has(source)) { event.preventDefault(); releaseInput(source); }
    });
    window.addEventListener('blur', emergencyStop);
    document.addEventListener('visibilitychange', () => { if (document.hidden) emergencyStop(); });
    document.addEventListener('focusin', event => { if (editable(event.target)) emergencyStop(); });
    window.addEventListener('pagehide', () => {
        // Keep GATT alive for STOP while the page can still run. Unloading remains
        // best effort; a physical disconnect must also be handled by the firmware.
        if (link) void disconnect();
        else teardown('연결을 해제했습니다. 다시 연결해 주세요.');
    });
}

loadSettings();
setupEventListeners();
paintInputs();
updateConnectionUI('연결 안 됨');
if (document.body.dataset.standalone === 'true' || location.protocol === 'file:') {
    $('btn-download').hidden = true;
    if ($('offline-note')) { $('offline-note').hidden = false; $('offline-note').textContent = '다운로드한 오프라인 조종기 · 인터넷 없이 블루투스로 연결할 수 있어요.'; }
}
