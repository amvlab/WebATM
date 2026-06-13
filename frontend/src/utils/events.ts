import { logger } from './Logger';

/**
 * Minimal typed pub/sub used by StateManager and ConnectionStatusService.
 * Listeners are invoked synchronously; exceptions are caught so one bad listener
 * cannot break others (same semantics as the prior hand-rolled implementations).
 */
export class EventEmitter<T> {
    private listeners: Set<(data: T) => void> = new Set();

    constructor(private readonly logContext: string = 'EventEmitter') {}

    subscribe(listener: (data: T) => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    emit(data: T): void {
        this.listeners.forEach((listener) => {
            try {
                listener(data);
            } catch (error) {
                logger.error(this.logContext, 'Listener threw:', error);
            }
        });
    }

    clear(): void {
        this.listeners.clear();
    }

    get size(): number {
        return this.listeners.size;
    }
}

/**
 * Tracks addEventListener registrations so they can be torn down in one call.
 * Replaces the identical hand-rolled arrays in BasePanel and Header.
 */
export class ListenerRegistry {
    private entries: Array<{
        element: EventTarget;
        event: string;
        handler: EventListenerOrEventListenerObject;
        options?: AddEventListenerOptions | boolean;
    }> = [];

    add(
        element: EventTarget,
        event: string,
        handler: EventListenerOrEventListenerObject,
        options?: AddEventListenerOptions | boolean
    ): void {
        element.addEventListener(event, handler, options);
        this.entries.push({ element, event, handler, options });
    }

    removeAll(): void {
        for (const { element, event, handler, options } of this.entries) {
            element.removeEventListener(event, handler, options);
        }
        this.entries = [];
    }

    get size(): number {
        return this.entries.length;
    }
}
