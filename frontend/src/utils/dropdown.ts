/**
 * Generic keyboard-navigable autocomplete dropdown.
 *
 * Console.ts historically carried two near-identical implementations for ACID
 * and aircraft-type suggestions; this class captures the shared structure while
 * leaving rendering and selection behaviour to the caller.
 */
export interface DropdownOptions<T> {
    /** Parent the dropdown element is appended to. */
    container: HTMLElement;
    /** CSS class on the dropdown root element (e.g. "acid-autocomplete-dropdown"). */
    rootClass: string;
    /** CSS class on each item (e.g. "acid-dropdown-item"). */
    itemClass: string;
    /** Renders an item's text/innerHTML. Return a string or an HTMLElement. */
    renderItem: (value: T, index: number) => string | HTMLElement;
    /** Called when an item is chosen (click, Tab, or Enter). */
    onSelect: (value: T, index: number) => void;
}

export class Dropdown<T> {
    private element: HTMLDivElement;
    private items: T[] = [];
    private selectedIndex = -1;

    constructor(private readonly opts: DropdownOptions<T>) {
        this.element = document.createElement('div');
        this.element.className = opts.rootClass;
        this.element.style.display = 'none';
        opts.container.appendChild(this.element);
    }

    /** Replace the visible item list. Passing [] hides the dropdown. */
    setItems(items: T[]): void {
        this.items = items;
        if (items.length === 0) {
            this.hide();
            return;
        }
        if (this.selectedIndex >= items.length) {
            this.selectedIndex = -1;
        }
        this.render();
    }

    /** True if the dropdown is currently visible. */
    isOpen(): boolean {
        return this.element.style.display !== 'none';
    }

    hide(): void {
        this.element.style.display = 'none';
        this.items = [];
        this.selectedIndex = -1;
    }

    getItems(): readonly T[] {
        return this.items;
    }

    getSelectedIndex(): number {
        return this.selectedIndex;
    }

    /**
     * Consume a keyboard event. Returns true if the dropdown handled it.
     * The caller is responsible for calling preventDefault / stopPropagation.
     */
    handleKey(key: string): boolean {
        if (!this.isOpen()) return false;

        if (key === 'ArrowDown') {
            this.selectedIndex = Math.min(this.selectedIndex + 1, this.items.length - 1);
            this.render();
            return true;
        }
        if (key === 'ArrowUp') {
            this.selectedIndex = Math.max(this.selectedIndex - 1, -1);
            this.render();
            return true;
        }
        if (key === 'Tab' || key === 'Enter') {
            if (this.selectedIndex >= 0 && this.selectedIndex < this.items.length) {
                this.opts.onSelect(this.items[this.selectedIndex], this.selectedIndex);
                return true;
            }
            return false;
        }
        if (key === 'Escape') {
            this.hide();
            return true;
        }
        return false;
    }

    private render(): void {
        this.element.innerHTML = '';
        this.items.forEach((value, index) => {
            const item = document.createElement('div');
            item.className = this.opts.itemClass;
            if (index === this.selectedIndex) {
                item.classList.add('selected');
            }
            const rendered = this.opts.renderItem(value, index);
            if (typeof rendered === 'string') {
                item.textContent = rendered;
            } else {
                item.appendChild(rendered);
            }
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                this.opts.onSelect(value, index);
            });
            item.addEventListener('mouseenter', () => {
                const prev = this.element.querySelector(`.${this.opts.itemClass}.selected`);
                if (prev) prev.classList.remove('selected');
                item.classList.add('selected');
                this.selectedIndex = index;
            });
            this.element.appendChild(item);
        });

        this.element.style.display = 'block';
        if (this.selectedIndex >= 0) {
            const selectedEl = this.element.children[this.selectedIndex] as HTMLElement | undefined;
            if (selectedEl) {
                selectedEl.scrollIntoView({ block: 'nearest' });
            }
        }
    }
}
