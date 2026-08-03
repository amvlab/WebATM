// @vitest-environment happy-dom
/**
 * Tests for RouteConstraintsModal close/submit semantics: every way of
 * closing the modal (Cancel button, X, backdrop, Escape all funnel through
 * ModalManager.close) must report exactly one cancel while a route is
 * pending, and a successful submit must report complete - not cancel.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RouteConstraintsModal } from './RouteConstraintsModal';
import { modalManager } from '../../ModalManager';
import type { App } from '../../../core/App';

const MODAL_ID = 'route-constraints-modal';

function buildModalDom(): void {
    document.body.innerHTML =
        `<div id="${MODAL_ID}" class="modal" style="display: none;">` +
        `  <button id="${MODAL_ID}-close"></button>` +
        '  <span id="route-constraints-target"></span>' +
        '  <input type="checkbox" id="route-constraints-bulk-toggle" checked>' +
        '  <div id="route-constraints-bulk-inputs">' +
        '    <input type="number" id="route-constraints-bulk-alt">' +
        '    <input type="number" id="route-constraints-bulk-spd">' +
        '  </div>' +
        '  <table id="route-constraints-table"><tbody></tbody></table>' +
        '  <button id="submit-route-constraints-btn"></button>' +
        '  <button id="cancel-route-constraints-btn"></button>' +
        '</div>';
    modalManager.registerModal(MODAL_ID);
}

describe('RouteConstraintsModal', () => {
    let sendCommand: ReturnType<typeof vi.fn<(cmd: string) => Promise<boolean>>>;
    let onComplete: ReturnType<typeof vi.fn<() => void>>;
    let onCancel: ReturnType<typeof vi.fn<() => void>>;

    function makeModal(): RouteConstraintsModal {
        const app = {
            sendCommand,
            getConsole: () => null,
        } as unknown as App;
        return new RouteConstraintsModal(app, onComplete, onCancel);
    }

    beforeEach(() => {
        buildModalDom();
        sendCommand = vi.fn<(cmd: string) => Promise<boolean>>(async () => true);
        onComplete = vi.fn<() => void>();
        onCancel = vi.fn<() => void>();
    });

    it('reports a single cancel when the modal is closed while a route is pending', () => {
        const modal = makeModal();
        modal.show('KL204', [{ lat: 52, lng: 4 }], 'ft', 'knots');
        expect(modalManager.isOpen(MODAL_ID)).toBe(true);

        // Any close path (X, backdrop, Escape) funnels through here.
        modalManager.close(MODAL_ID);
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onComplete).not.toHaveBeenCalled();

        // A second close (already closed) must not cancel again.
        modalManager.close(MODAL_ID);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('the Cancel button closes the modal and cancels the pending route', () => {
        const modal = makeModal();
        modal.show('KL204', [{ lat: 52, lng: 4 }], 'ft', 'knots');

        (document.getElementById('cancel-route-constraints-btn') as HTMLButtonElement).click();
        expect(modalManager.isOpen(MODAL_ID)).toBe(false);
        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('submit sends ADDWPT per waypoint, completes, and does not cancel', async () => {
        const modal = makeModal();
        modal.show('KL204', [{ lat: 52, lng: 4 }], 'ft', 'knots');

        (document.getElementById('submit-route-constraints-btn') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

        expect(sendCommand).toHaveBeenCalledWith('ADDWPT KL204 52.000000,4.000000');
        expect(modalManager.isOpen(MODAL_ID)).toBe(false);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('a second submit click while commands are still sending is ignored', async () => {
        const resolvers: Array<(ok: boolean) => void> = [];
        sendCommand = vi.fn<(cmd: string) => Promise<boolean>>(
            () => new Promise<boolean>(resolve => { resolvers.push(resolve); })
        );
        const modal = makeModal();
        modal.show('KL204', [{ lat: 52, lng: 4 }], 'ft', 'knots');

        const submitBtn = document.getElementById('submit-route-constraints-btn') as HTMLButtonElement;
        submitBtn.click();
        submitBtn.click(); // double-click: must not start a second send loop
        expect(sendCommand).toHaveBeenCalledTimes(1);
        expect(submitBtn.disabled).toBe(true);

        resolvers[0](true);
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(sendCommand).toHaveBeenCalledTimes(1);
        expect(submitBtn.disabled).toBe(false);
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('closing the modal mid-send is not reported as a cancel', async () => {
        const resolvers: Array<(ok: boolean) => void> = [];
        sendCommand = vi.fn<(cmd: string) => Promise<boolean>>(
            () => new Promise<boolean>(resolve => { resolvers.push(resolve); })
        );
        const modal = makeModal();
        modal.show('KL204', [{ lat: 52, lng: 4 }], 'ft', 'knots');

        (document.getElementById('submit-route-constraints-btn') as HTMLButtonElement).click();
        modalManager.close(MODAL_ID);
        expect(onCancel).not.toHaveBeenCalled();

        resolvers[0](true);
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(onCancel).not.toHaveBeenCalled();
    });

    it('bulk constraints apply to every waypoint on submit', async () => {
        const modal = makeModal();
        modal.show(
            'KL204',
            [{ lat: 52, lng: 4 }, { lat: 53, lng: 5 }],
            'ft',
            'knots'
        );

        (document.getElementById('route-constraints-bulk-alt') as HTMLInputElement).value = '20000';
        (document.getElementById('route-constraints-bulk-spd') as HTMLInputElement).value = '300';

        (document.getElementById('submit-route-constraints-btn') as HTMLButtonElement).click();
        await vi.waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

        expect(sendCommand).toHaveBeenCalledWith('ADDWPT KL204 52.000000,4.000000,20000,300');
        expect(sendCommand).toHaveBeenCalledWith('ADDWPT KL204 53.000000,5.000000,20000,300');
        expect(onCancel).not.toHaveBeenCalled();
    });
});
