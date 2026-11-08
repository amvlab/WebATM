// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { Header } from './Header';
import { StateManager } from '../core/StateManager';
import type { SocketManager } from '../core/SocketManager';
import type { SimInfo } from '../data/types';

/**
 * The play/pause toggle must decide by run state (2 = OP), the same
 * criterion updateControlsForSimState uses to enable it — not by SIMINFO's
 * measured speed, which is a wall-clock average that lags state flips.
 */

function makeHeader() {
    document.body.innerHTML = `
        <div class="header">
            <span id="bluesky-connection-status"></span>
            <button id="play-btn"></button>
            <button id="play-pause-btn"></button>
            <button id="reset-btn"></button>
            <select id="speed-select"></select>
            <button id="settings-btn"></button>
            <span id="sim-time"></span>
            <span id="sim-rate"></span>
        </div>`;

    const header = new Header();
    const stateManager = new StateManager();
    const sendCommand = vi.fn().mockResolvedValue(true);

    header.init();
    header.setStateManager(stateManager);
    header.setSocketManager({ sendCommand } as unknown as SocketManager);

    return { stateManager, sendCommand };
}

function clickPlayPause(): void {
    document.getElementById('play-pause-btn')!.click();
}

describe('Header play/pause toggle', () => {
    it('sends HOLD while the sim is running (state OP)', () => {
        const { stateManager, sendCommand } = makeHeader();
        stateManager.updateSimInfo({ state: 2, speed: 1 } as SimInfo);

        clickPlayPause();

        expect(sendCommand).toHaveBeenCalledWith('HOLD');
    });

    it('sends HOLD when running even while the measured speed still reads 0', () => {
        // First SIMINFO after resuming: state is already OP but the
        // wall-clock speed average can still be 0. The old speed===0
        // criterion sent OP again here, making the sim unpausable.
        const { stateManager, sendCommand } = makeHeader();
        stateManager.updateSimInfo({ state: 2, speed: 0 } as SimInfo);

        clickPlayPause();

        expect(sendCommand).toHaveBeenCalledWith('HOLD');
    });

    it('sends OP while the sim is paused (state HOLD)', () => {
        const { stateManager, sendCommand } = makeHeader();
        stateManager.updateSimInfo({ state: 1, speed: 0 } as SimInfo);

        clickPlayPause();

        expect(sendCommand).toHaveBeenCalledWith('OP');
    });
});
