// @vitest-environment happy-dom
/**
 * Wiring of the standard modals (Modals + BlueSkyFileManager + ModalManager).
 *
 * Regression focus: the upload-files modal used to be shown by setting
 * style.display directly, bypassing ModalManager. That left its isOpen state
 * false, so Escape/backdrop close ignored it and opening another modal
 * stacked on top of it instead of closing it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

function buildDom(): void {
    // The standard modals plus the minimum the BlueSkyFileManager singleton
    // needs to construct (it reads file-type-select on init).
    document.body.innerHTML = `
        <button id="upload-files-btn"></button>
        <select id="file-type-select"><option value="scenario">Scenario</option></select>
        <input id="file-input" />

        <div id="upload-files-modal" class="modal" style="display: none;">
            <button class="modal-close" id="upload-files-close">&times;</button>
        </div>
        <div id="create-aircraft-modal" class="modal" style="display: none;">
            <button class="modal-close" id="create-aircraft-modal-close">&times;</button>
            <button id="cancel-aircraft-btn"></button>
        </div>
        <div id="polygon-name-modal" class="modal" style="display: none;">
            <button class="modal-close" id="polygon-name-modal-close">&times;</button>
            <button id="cancel-polygon-btn"></button>
        </div>
    `;
}

async function importModals() {
    const [{ modals }, { modalManager }, { blueSkyFileManager }] = await Promise.all([
        import('./Modals'),
        import('./ModalManager'),
        import('./BlueSkyFileManager'),
    ]);
    modals.forceInitialize();
    return { modals, modalManager, blueSkyFileManager };
}

describe('Modals wiring', () => {
    beforeEach(() => {
        vi.resetModules(); // fresh singletons per test
        buildDom();
        // BlueSkyFileManager fires checkCurrentStatus() (a fetch) on
        // construction and on every modal open; report "not configured".
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({ json: async () => ({ configured: false }) }),
        );
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('opens the upload modal through the modal manager', async () => {
        const { modalManager } = await importModals();

        document.getElementById('upload-files-btn')!.click();

        const modal = document.getElementById('upload-files-modal')!;
        expect(modal.style.display).toBe('flex');
        expect(modalManager.isOpen('upload-files-modal')).toBe(true);
        expect(document.body.classList.contains('modal-open')).toBe(true);
    });

    it('closes the upload modal with Escape', async () => {
        const { modalManager } = await importModals();

        document.getElementById('upload-files-btn')!.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

        const modal = document.getElementById('upload-files-modal')!;
        expect(modal.style.display).toBe('none');
        expect(modalManager.isOpen('upload-files-modal')).toBe(false);
        expect(document.body.classList.contains('modal-open')).toBe(false);
    });

    it('closes the upload modal when another modal opens', async () => {
        const { modalManager } = await importModals();

        document.getElementById('upload-files-btn')!.click();
        modalManager.open('create-aircraft-modal');

        expect(modalManager.isOpen('upload-files-modal')).toBe(false);
        expect(document.getElementById('upload-files-modal')!.style.display).toBe('none');
        expect(modalManager.isOpen('create-aircraft-modal')).toBe(true);
    });

    it('closes the upload modal via its close (X) button', async () => {
        const { modalManager } = await importModals();

        document.getElementById('upload-files-btn')!.click();
        document.getElementById('upload-files-close')!.click();

        expect(modalManager.isOpen('upload-files-modal')).toBe(false);
        expect(document.getElementById('upload-files-modal')!.style.display).toBe('none');
    });

    it('closes modals via their cancel buttons', async () => {
        const { modalManager } = await importModals();

        modalManager.open('create-aircraft-modal');
        document.getElementById('cancel-aircraft-btn')!.click();
        expect(modalManager.isOpen('create-aircraft-modal')).toBe(false);

        modalManager.open('polygon-name-modal');
        document.getElementById('cancel-polygon-btn')!.click();
        expect(modalManager.isOpen('polygon-name-modal')).toBe(false);
    });

    it('resets the file-manager browse state on every open', async () => {
        const { blueSkyFileManager } = await importModals();
        const statusSpy = vi.spyOn(blueSkyFileManager, 'openModal');
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockClear();

        document.getElementById('upload-files-btn')!.click();

        expect(statusSpy).toHaveBeenCalledTimes(1);
        // checkCurrentStatus() runs on open
        expect(fetchMock).toHaveBeenCalled();
    });

    it('does not double-wire buttons when initialized twice', async () => {
        const { modals, blueSkyFileManager } = await importModals();
        modals.forceInitialize(); // second call must be a no-op

        const openSpy = vi.spyOn(blueSkyFileManager, 'openModal');
        document.getElementById('upload-files-btn')!.click();

        expect(openSpy).toHaveBeenCalledTimes(1);
    });
});
