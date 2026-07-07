// @vitest-environment happy-dom
/**
 * Characterization tests for ModalManager.
 *
 * Pins the "one modal at a time" contract: opening a modal closes any other
 * open modal, the `modal-open` body class tracks whether any modal is showing,
 * lifecycle events fire in order, and Escape / backdrop clicks close the open
 * modal. These guard the refactor that dropped the never-reached
 * confirmation-modal stacking branch in favour of a single tracked modal id.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ModalManager } from './ModalManager';

vi.mock('../utils/Logger', () => ({
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
}));

function buildDom(): void {
    document.body.innerHTML = `
        <div id="alpha-modal" class="modal" style="display: none;">
            <div class="modal-content">
                <button class="modal-close" id="alpha-modal-close">&times;</button>
            </div>
        </div>
        <div id="beta-modal" class="modal" style="display: none;">
            <div class="modal-content">
                <button class="modal-close" id="beta-modal-close">&times;</button>
            </div>
        </div>
    `;
}

describe('ModalManager', () => {
    let manager: ModalManager;

    beforeEach(() => {
        buildDom();
        document.body.classList.remove('modal-open');
        // readyState is 'complete' under happy-dom, so registration runs eagerly.
        manager = new ModalManager();
    });

    it('auto-registers every [id$="-modal"] element in the DOM', () => {
        expect(manager.getRegisteredModals().sort()).toEqual(['alpha-modal', 'beta-modal']);
    });

    it('opens a modal, showing it and marking the body', () => {
        expect(manager.open('alpha-modal')).toBe(true);
        expect(manager.isOpen('alpha-modal')).toBe(true);
        expect(manager.getModal('alpha-modal')!.style.display).toBe('flex');
        expect(manager.getOpenModal()).toBe('alpha-modal');
        expect(document.body.classList.contains('modal-open')).toBe(true);
    });

    it('opening a second modal closes the first (only one open at a time)', () => {
        manager.open('alpha-modal');
        manager.open('beta-modal');

        expect(manager.isOpen('alpha-modal')).toBe(false);
        expect(manager.isOpen('beta-modal')).toBe(true);
        expect(manager.getModal('alpha-modal')!.style.display).toBe('none');
        expect(manager.getOpenModal()).toBe('beta-modal');
        expect(document.body.classList.contains('modal-open')).toBe(true);
    });

    it('closing the open modal clears the body class', () => {
        manager.open('alpha-modal');
        expect(manager.close('alpha-modal')).toBe(true);

        expect(manager.isOpen('alpha-modal')).toBe(false);
        expect(manager.getOpenModal()).toBeNull();
        expect(document.body.classList.contains('modal-open')).toBe(false);
    });

    it('open/close on an unregistered modal returns false without throwing', () => {
        expect(manager.open('ghost-modal')).toBe(false);
        expect(manager.close('ghost-modal')).toBe(false);
    });

    it('re-opening the already-open modal is a no-op that stays open', () => {
        manager.open('alpha-modal');
        const events: string[] = [];
        manager.on('alpha-modal', type => events.push(type));

        expect(manager.open('alpha-modal')).toBe(true);
        expect(manager.isOpen('alpha-modal')).toBe(true);
        expect(events).toEqual([]); // no beforeOpen/open re-fired
    });

    it('emits lifecycle events in order', () => {
        const events: string[] = [];
        manager.on('alpha-modal', type => events.push(`a:${type}`));
        manager.on('beta-modal', type => events.push(`b:${type}`));

        manager.open('alpha-modal');
        manager.open('beta-modal'); // closes alpha first

        expect(events).toEqual([
            'a:beforeOpen',
            'a:open',
            'b:beforeOpen',
            'a:beforeClose',
            'a:close',
            'b:open',
        ]);
    });

    it('closeAll() closes every open modal and clears the body class', () => {
        manager.open('alpha-modal');
        manager.closeAll();

        expect(manager.isOpen('alpha-modal')).toBe(false);
        expect(manager.getOpenModal()).toBeNull();
        expect(document.body.classList.contains('modal-open')).toBe(false);
    });

    it('clicking the close button closes the modal', () => {
        manager.open('alpha-modal');
        (document.getElementById('alpha-modal-close') as HTMLButtonElement).click();

        expect(manager.isOpen('alpha-modal')).toBe(false);
    });

    it('Escape closes the open modal', () => {
        manager.open('alpha-modal');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(manager.isOpen('alpha-modal')).toBe(false);
        expect(manager.getOpenModal()).toBeNull();
    });

    it('clicking the modal backdrop closes it', () => {
        manager.open('alpha-modal');
        manager.getModal('alpha-modal')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        expect(manager.isOpen('alpha-modal')).toBe(false);
    });

    it('destroy() detaches document listeners so Escape no longer closes', () => {
        manager.open('alpha-modal');
        manager.destroy();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        expect(manager.isOpen('alpha-modal')).toBe(true); // listener was removed
    });

    it('off() removes a previously registered handler', () => {
        const seen: string[] = [];
        const handler = (type: string): void => {
            seen.push(type);
        };
        manager.on('alpha-modal', handler);
        manager.off('alpha-modal', handler);

        manager.open('alpha-modal');
        expect(seen).toEqual([]);
    });
});
