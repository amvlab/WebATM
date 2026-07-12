// @vitest-environment happy-dom
/**
 * Tests for AircraftInteractionManager cleanup: the document-level panel
 * click listeners used to outlive destroy() (only map listeners die with
 * the map), so a destroyed manager kept reacting to panel clicks.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { AircraftInteractionManager } from './AircraftInteractionManager';
import { StateManager } from '../../../core/StateManager';
import type { MapDisplay } from '../MapDisplay';
import type { SocketManager } from '../../../core/SocketManager';

const stubMap = () => ({
    on: vi.fn(),
    once: vi.fn(),
    getLayer: vi.fn(() => undefined),
    queryRenderedFeatures: vi.fn(() => []),
    getZoom: vi.fn(() => 8),
    easeTo: vi.fn(),
    flyTo: vi.fn(),
    getCanvas: vi.fn(() => ({ style: {} })),
});

const panelClick = (aircraftId: string) =>
    document.dispatchEvent(new CustomEvent('aircraft-single-click', { detail: { aircraftId } }));

describe('AircraftInteractionManager', () => {
    let manager: AircraftInteractionManager;
    let sendCommand: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        sendCommand = vi.fn();
        manager = new AircraftInteractionManager(
            { getMap: () => stubMap() } as unknown as MapDisplay,
            new StateManager(),
            { sendCommand } as unknown as SocketManager,
        );
    });

    afterEach(() => {
        manager.destroy();
    });

    it('requests route data when a panel single-click event arrives', () => {
        panelClick('KL123');
        expect(sendCommand).toHaveBeenCalledWith('POS KL123');
    });

    it('stops listening to panel click events after destroy', () => {
        manager.destroy();
        panelClick('KL123');
        expect(sendCommand).not.toHaveBeenCalled();
    });
});
