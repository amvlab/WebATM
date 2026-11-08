// @vitest-environment happy-dom
/**
 * Tests for the Create Aircraft modal form logic.
 *
 * Pins two fixed behaviors:
 * - The openap type warning must not flash while the user is still typing a
 *   value that can complete to a listed type ("A3" on the way to "A320");
 *   it shows while typing only when nothing can match, and on blur for any
 *   settled non-openap value.
 * - Enter mirrors the visible submit button in both modes: Create Aircraft
 *   (manual) and Start Drawing (map).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AircraftCreationForm, AircraftCreationData } from './AircraftCreationForm';

function setupDom(): void {
    document.body.innerHTML = `
        <div id="create-aircraft-modal" class="modal" style="display: none;">
            <select id="aircraft-creation-mode">
                <option value="manual">Manual Input</option>
                <option value="map">Draw on Map</option>
            </select>
            <input type="text" id="aircraft-id-input">
            <div class="actype-input-wrapper">
                <input type="text" id="aircraft-type-input">
            </div>
            <small id="aircraft-type-warning" style="display: none;"></small>
            <div id="manual-position-fields">
                <input type="number" id="aircraft-lat-input">
                <input type="number" id="aircraft-lon-input">
                <input type="number" id="aircraft-hdg-input">
            </div>
            <input type="number" id="aircraft-alt-input">
            <input type="number" id="aircraft-spd-input">
            <div id="map-drawing-instruction" style="display: none;"></div>
            <button id="create-aircraft-submit"></button>
            <button id="start-aircraft-drawing" style="display: none;"></button>
        </div>
    `;
}

function el<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T;
}

function typeValue(id: string, value: string): void {
    const input = el<HTMLInputElement>(id);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
}

function pressEnter(id: string): void {
    el<HTMLInputElement>(id).dispatchEvent(
        new KeyboardEvent('keypress', { key: 'Enter', bubbles: true, cancelable: true })
    );
}

function warningVisible(): boolean {
    return el<HTMLElement>('aircraft-type-warning').style.display !== 'none';
}

describe('AircraftCreationForm', () => {
    let onStartDrawing: ReturnType<typeof vi.fn<(data: AircraftCreationData) => void>>;

    beforeEach(() => {
        setupDom();
        vi.stubGlobal('alert', vi.fn());
        onStartDrawing = vi.fn();
        new AircraftCreationForm(onStartDrawing);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
        delete window.app;
        document.body.innerHTML = '';
    });

    describe('openap type warning', () => {
        it('stays hidden while typing a prefix of a listed type', () => {
            typeValue('aircraft-type-input', 'A3');
            expect(warningVisible()).toBe(false);
        });

        it('stays hidden while typing a substring of a listed type', () => {
            typeValue('aircraft-type-input', '320');
            expect(warningVisible()).toBe(false);
        });

        it('stays hidden for a complete listed type, in any case', () => {
            typeValue('aircraft-type-input', 'a320');
            expect(warningVisible()).toBe(false);
        });

        it('shows while typing once nothing can match', () => {
            typeValue('aircraft-type-input', 'ZZ');
            expect(warningVisible()).toBe(true);
            expect(el('aircraft-type-warning').textContent).toContain('"ZZ"');
        });

        it('hides again when the value becomes matchable', () => {
            typeValue('aircraft-type-input', 'ZZ');
            typeValue('aircraft-type-input', 'A3');
            expect(warningVisible()).toBe(false);
        });

        it('shows on blur for a settled partial that is not a listed type', () => {
            vi.useFakeTimers();
            typeValue('aircraft-type-input', 'A3');
            expect(warningVisible()).toBe(false);

            el('aircraft-type-input').dispatchEvent(new Event('blur'));
            vi.advanceTimersByTime(150);
            expect(warningVisible()).toBe(true);
        });

        it('stays hidden on blur for a complete listed type', () => {
            vi.useFakeTimers();
            typeValue('aircraft-type-input', 'A320');
            el('aircraft-type-input').dispatchEvent(new Event('blur'));
            vi.advanceTimersByTime(150);
            expect(warningVisible()).toBe(false);
        });
    });

    describe('Enter submits per mode', () => {
        function fillCommonFields(): void {
            typeValue('aircraft-id-input', 'KL1');
            typeValue('aircraft-type-input', 'A320');
            typeValue('aircraft-alt-input', '10000');
            typeValue('aircraft-spd-input', '250');
        }

        function selectMode(mode: 'manual' | 'map'): void {
            const select = el<HTMLSelectElement>('aircraft-creation-mode');
            select.value = mode;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }

        it('manual mode: Enter sends the CRE command', () => {
            const app = {
                sendCommand: vi.fn(),
                getConsole: () => null,
                getState: () => ({ aircraftData: { id: [] } })
            };
            window.app = app as unknown as Window['app'];

            fillCommonFields();
            typeValue('aircraft-lat-input', '52');
            typeValue('aircraft-lon-input', '4');
            typeValue('aircraft-hdg-input', '90');
            pressEnter('aircraft-spd-input');

            expect(app.sendCommand).toHaveBeenCalledWith('CRE KL1,A320,52,4,90,10000,250');
            expect(alert).not.toHaveBeenCalled();
        });

        it('map mode: Enter starts drawing with the validated form data', () => {
            fillCommonFields();
            selectMode('map');
            pressEnter('aircraft-spd-input');

            expect(onStartDrawing).toHaveBeenCalledWith({
                id: 'KL1',
                actype: 'A320',
                altDisplay: 10000,
                altUnit: 'ft',
                spdDisplay: 250,
                spdUnit: 'knots'
            });
            expect(alert).not.toHaveBeenCalled();
        });

        it('map mode: Enter with a missing field alerts instead of starting', () => {
            typeValue('aircraft-id-input', 'KL1');
            selectMode('map');
            pressEnter('aircraft-id-input');

            expect(onStartDrawing).not.toHaveBeenCalled();
            expect(alert).toHaveBeenCalled();
        });
    });
});
