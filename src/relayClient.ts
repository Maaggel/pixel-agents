import type { SyncWindowState } from './types.js';
import { RELAY_RECONNECT_BASE_MS, RELAY_RECONNECT_MAX_MS } from './constants.js';

type LayoutData = Record<string, unknown>;

export interface RelayClient {
	pushState(state: SyncWindowState): void;
	pushLayout(layout: LayoutData): void;
	dispose(): void;
}

export function createRelayClient(
	url: string,
	token: string,
	onLayoutUpdate: (layout: LayoutData) => void,
	log: (msg: string) => void,
): RelayClient {
	let ws: WebSocket | null = null;
	let disposed = false;
	let reconnectDelay = RELAY_RECONNECT_BASE_MS;
	let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	let lastState: SyncWindowState | null = null;
	let lastLayout: LayoutData | null = null;

	function connect(): void {
		if (disposed) return;

		// Build WebSocket URL with auth params
		const separator = url.includes('?') ? '&' : '?';
		const wsUrl = `${url}${separator}role=publisher&token=${encodeURIComponent(token)}`;

		try {
			ws = new WebSocket(wsUrl);
		} catch (err) {
			log(`[Relay] WebSocket creation failed: ${err}`);
			scheduleReconnect();
			return;
		}

		ws.onopen = () => {
			log('[Relay] Connected to relay server');
			reconnectDelay = RELAY_RECONNECT_BASE_MS;
			// Re-send last known state on reconnect
			if (lastState) {
				send({ type: 'sync', state: lastState });
			}
			if (lastLayout) {
				send({ type: 'layout', layout: lastLayout });
			}
		};

		ws.onmessage = (event: MessageEvent) => {
			try {
				const msg = JSON.parse(String(event.data));
				if (msg.type === 'layoutUpdate' && msg.layout) {
					onLayoutUpdate(msg.layout);
				}
			} catch {
				// Ignore bad messages
			}
		};

		ws.onclose = () => {
			ws = null;
			if (!disposed) {
				log(`[Relay] Disconnected, reconnecting in ${reconnectDelay / 1000}s...`);
				scheduleReconnect();
			}
		};

		ws.onerror = () => {
			// onclose will fire after this
		};
	}

	function scheduleReconnect(): void {
		if (disposed) return;
		if (reconnectTimer) clearTimeout(reconnectTimer);
		reconnectTimer = setTimeout(() => {
			reconnectTimer = null;
			connect();
		}, reconnectDelay);
		reconnectDelay = Math.min(reconnectDelay * 2, RELAY_RECONNECT_MAX_MS);
	}

	function send(msg: object): void {
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify(msg));
		}
	}

	// Start connection
	connect();

	return {
		pushState(state: SyncWindowState): void {
			lastState = state;
			send({ type: 'sync', state });
		},

		pushLayout(layout: LayoutData): void {
			lastLayout = layout;
			send({ type: 'layout', layout });
		},

		dispose(): void {
			disposed = true;
			if (reconnectTimer) {
				clearTimeout(reconnectTimer);
				reconnectTimer = null;
			}
			if (ws) {
				ws.close();
				ws = null;
			}
		},
	};
}
