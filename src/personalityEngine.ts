/**
 * Personality Engine — Derives mood, thoughts, traits, and relationships
 * from real JSONL transcript events.
 *
 * Each agent develops:
 * - Mood: short-term emotional state (changes with events, decays to neutral)
 * - Thoughts: contextual inner monologue triggered by work events
 * - Traits: long-term personality axes (evolve slowly across sessions)
 * - Relationships: bonds with other agents (familiarity, collaboration)
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// ── Mood Types ──────────────────────────────────────────────

export const MoodType = {
	NEUTRAL: 'neutral',
	FOCUSED: 'focused',
	PRODUCTIVE: 'productive',
	ACCOMPLISHED: 'accomplished',
	SATISFIED: 'satisfied',
	FRUSTRATED: 'frustrated',
	IMPATIENT: 'impatient',
	TIRED: 'tired',
	RELAXED: 'relaxed',
	ENERGIZED: 'energized',
	CURIOUS: 'curious',
} as const;
export type MoodType = (typeof MoodType)[keyof typeof MoodType];

/** How long each mood persists before decaying toward neutral (seconds) */
const MOOD_DECAY_TIMES: Record<MoodType, number> = {
	neutral: Infinity,
	focused: 120,
	productive: 90,
	accomplished: 60,
	satisfied: 45,
	frustrated: 60,
	impatient: 30,
	tired: 180,
	relaxed: 120,
	energized: 60,
	curious: 45,
};

/** Mood valence: positive moods > 0, negative < 0, neutral = 0 */
const MOOD_VALENCE: Record<MoodType, number> = {
	neutral: 0,
	focused: 0.3,
	productive: 0.6,
	accomplished: 0.9,
	satisfied: 0.7,
	frustrated: -0.6,
	impatient: -0.3,
	tired: -0.2,
	relaxed: 0.2,
	energized: 0.5,
	curious: 0.4,
};

// ── Data Structures ─────────────────────────────────────────

export interface MoodState {
	current: MoodType;
	/** 0–1 intensity of the current mood */
	intensity: number;
	/** Timestamp (ms) when this mood started */
	since: number;
	/** Valence history: recent mood valences for computing average sentiment */
	recentValences: number[];
}

export interface PersonalityTraits {
	/** 0 = exploratory (dives in), 1 = methodical (researches first) */
	methodical: number;
	/** 0 = independent (solo work), 1 = collaborative (delegates often) */
	collaborative: number;
	/** 0 = bold (acts fast), 1 = careful (checks before acting) */
	careful: number;
	/** 0 = generalist (broad), 1 = specialist (narrow focus) */
	specialist: number;
}

export interface Thought {
	text: string;
	mood: MoodType;
	timestamp: number;
	/** What triggered this thought (e.g., 'turn_complete', 'tool_error') */
	trigger: string;
}

export interface Relationship {
	agentId: string;
	/** Display name of the other agent */
	name: string;
	/** 0–100: how much time spent in same workspace */
	familiarity: number;
	/** 0–100: how much they've collaborated (Task delegations, shared files) */
	collaboration: number;
	/** -50 to +50: overall sentiment toward this agent */
	sentiment: number;
}

export interface WorkStats {
	totalTools: number;
	toolCounts: Record<string, number>;
	totalTurns: number;
	totalErrors: number;
	totalSubagents: number;
	turnDurations: number[];
	fileTypesTouched: string[];
	sessionStartTime: number;
	/** Total active working time in seconds */
	activeTimeSec: number;
}

export interface AgentPersonality {
	/** Stable agent identifier (definitionId or fallback key) */
	agentKey: string;
	/** Display name */
	name: string;
	mood: MoodState;
	traits: PersonalityTraits;
	/** Recent thoughts (most recent first, capped) */
	thoughts: Thought[];
	relationships: Relationship[];
	stats: WorkStats;
	/** Mood timeline for graph: [timestamp, moodType, intensity, trigger] */
	moodHistory: Array<[number, MoodType, number, string]>;
}

const MAX_THOUGHTS = 50;
const MAX_MOOD_HISTORY = 200;
const MAX_RECENT_VALENCES = 20;
const MAX_TURN_DURATIONS = 50;
const TRAIT_LEARNING_RATE = 0.02; // How fast traits evolve per event

// ── Thought Templates ───────────────────────────────────────
// Keyed by "trigger:mood" — multiple variants picked randomly

const THOUGHT_TEMPLATES: Record<string, string[]> = {
	// ── Turn completion ──
	'turn_complete:accomplished': [
		'That was a big one, but we got there',
		'Proud of that piece of work',
		'Complex task, solid result',
		'That took some effort, worth it though',
	],
	'turn_complete:satisfied': [
		'That went smoothly',
		'Clean execution',
		'Happy with how that turned out',
		'Nice, exactly what was needed',
	],
	'turn_complete:productive': [
		'Good progress today',
		'Keeping up the momentum',
		'Another one done, what\'s next?',
	],
	'turn_complete:neutral': [
		'Task complete',
		'Done with that one',
		'On to the next thing',
	],

	// ── Tool errors / retries ──
	'tool_retry:frustrated': [
		'Hmm, that didn\'t work as expected',
		'Let me try a different approach...',
		'Why won\'t this cooperate?',
		'Something\'s off here',
	],
	'tool_error:frustrated': [
		'That\'s not right...',
		'OK, let me rethink this',
		'Unexpected result, need to dig deeper',
	],

	// ── Permission / waiting ──
	'permission_wait:impatient': [
		'Waiting for approval...',
		'Ready when you are',
		'I\'d like to keep going on this',
	],
	'permission_wait:neutral': [
		'Standing by for permission',
		'Need the go-ahead to continue',
	],

	// ── New task ──
	'new_task:energized': [
		'New challenge, let\'s see what we\'ve got',
		'Interesting, let me think about this',
		'Ready to dive in',
	],
	'new_task:curious': [
		'Hmm, this looks interesting',
		'Let me explore this a bit',
		'I have some ideas about this',
	],
	'new_task:neutral': [
		'Let\'s get started',
		'OK, looking at this now',
	],
	'new_task:tired': [
		'Another one? Let me gather my thoughts...',
		'OK, focusing up',
	],

	// ── Idle ──
	'idle:relaxed': [
		'Nice break',
		'I wonder what\'s next',
		'Good time to catch my breath',
	],
	'idle:tired': [
		'Could use a longer break',
		'It\'s been a busy session',
		'Winding down a bit',
	],
	'idle:neutral': [
		'Quiet moment',
		'Standing by',
	],

	// ── Research / reading ──
	'research:curious': [
		'Interesting codebase structure',
		'Let me understand this better',
		'There\'s a lot going on here',
	],
	'research:focused': [
		'Tracing through the logic...',
		'Following the data flow',
		'Need to understand this before changing it',
	],

	// ── Building / editing ──
	'building:productive': [
		'This is coming together nicely',
		'Good flow right now',
		'Making solid progress',
	],
	'building:focused': [
		'Deep in the code',
		'Concentrating on getting this right',
		'Almost there...',
	],

	// ── Testing / building ──
	'testing:satisfied': [
		'Tests are passing, that\'s a good sign',
		'Build succeeded, nice',
	],
	'testing:frustrated': [
		'Build failed, let me check what went wrong',
		'Tests aren\'t happy...',
	],

	// ── Collaboration ──
	'delegating:collaborative': [
		'Let me get some help on this',
		'This part could use a fresh perspective',
	],
	'collab_complete:satisfied': [
		'Good teamwork on that',
		'The specialist handled that well',
	],

	// ── Session start ──
	'session_start:energized': [
		'Good to be back, ready to work',
		'Fresh session, let\'s go',
		'Alright, where were we?',
	],
};

// ── Personality Engine ──────────────────────────────────────

export class PersonalityEngine {
	private personalities: Map<string, AgentPersonality> = new Map();
	/** Maps runtime agent ID → stable agent key */
	private agentKeyMap: Map<number, string> = new Map();
	private projectHash: string;
	private persistPath: string;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(projectHash: string) {
		this.projectHash = projectHash;
		const dir = path.join(os.homedir(), '.pixel-agents', 'personalities');
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		this.persistPath = path.join(dir, `${projectHash}.json`);
		this.load();
	}

	/** Register a runtime agent ID with a stable key (definitionId or fallback) */
	registerAgent(runtimeId: number, agentKey: string, name: string): void {
		this.agentKeyMap.set(runtimeId, agentKey);
		if (!this.personalities.has(agentKey)) {
			this.personalities.set(agentKey, createDefaultPersonality(agentKey, name));
		} else {
			// Update name in case it changed
			const p = this.personalities.get(agentKey)!;
			p.name = name;
		}
	}

	/** Unregister a runtime agent (terminal closed) */
	unregisterAgent(runtimeId: number): void {
		this.agentKeyMap.delete(runtimeId);
		this.scheduleSave();
	}

	/** Get personality for a runtime agent ID */
	getPersonality(runtimeId: number): AgentPersonality | undefined {
		const key = this.agentKeyMap.get(runtimeId);
		return key ? this.personalities.get(key) : undefined;
	}

	/** Get all personalities (for UI) */
	getAllPersonalities(): AgentPersonality[] {
		return [...this.personalities.values()];
	}

	// ── Event handlers (called from transcript parser) ──────

	/** Agent started working on a new user prompt */
	onNewTask(runtimeId: number): void {
		const p = this.getP(runtimeId);
		if (!p) return;

		const isFirstTask = p.stats.totalTurns === 0;
		if (isFirstTask) {
			this.setMood(p, MoodType.ENERGIZED, 0.8, 'session_start');
			this.addThought(p, 'session_start', p.mood.current);
		} else {
			// Mood depends on current state
			const moodAfterIdle = this.timeSinceMood(p) > 30000
				? MoodType.ENERGIZED : MoodType.CURIOUS;
			this.setMood(p, moodAfterIdle, 0.6, 'new_task');
			this.addThought(p, 'new_task', p.mood.current);
		}
	}

	/** A tool started executing */
	onToolStart(runtimeId: number, toolName: string, _input: Record<string, unknown>): void {
		const p = this.getP(runtimeId);
		if (!p) return;

		p.stats.totalTools++;
		p.stats.toolCounts[toolName] = (p.stats.toolCounts[toolName] || 0) + 1;

		// Determine activity type for mood
		const isResearch = ['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(toolName);
		const isBuilding = ['Write', 'Edit', 'NotebookEdit'].includes(toolName);
		const isTesting = toolName === 'Bash:build' || toolName === 'Bash:test';
		const isDelegating = toolName === 'Task' || toolName === 'Agent';

		if (isDelegating) {
			p.stats.totalSubagents++;
			this.setMood(p, MoodType.PRODUCTIVE, 0.5, 'delegating');
			if (Math.random() < 0.3) this.addThought(p, 'delegating', 'collaborative');
			// Evolve collaborative trait
			this.evolveTrait(p, 'collaborative', 1);
		} else if (isResearch) {
			if (p.mood.current !== MoodType.FOCUSED) {
				this.setMood(p, MoodType.FOCUSED, 0.6, 'research');
			}
			if (Math.random() < 0.15) this.addThought(p, 'research', p.mood.current);
			this.evolveTrait(p, 'methodical', 1);
		} else if (isBuilding) {
			this.setMood(p, MoodType.PRODUCTIVE, 0.7, 'building');
			if (Math.random() < 0.15) this.addThought(p, 'building', p.mood.current);
			this.evolveTrait(p, 'methodical', 0); // building = exploratory
		} else if (isTesting) {
			this.setMood(p, MoodType.FOCUSED, 0.5, 'testing');
		}

		// Track file type diversity for specialist trait
		if (isBuilding || isResearch) {
			const filePath = _input.file_path as string | undefined;
			if (filePath) {
				const ext = path.extname(filePath).toLowerCase();
				if (ext && !p.stats.fileTypesTouched.includes(ext)) {
					p.stats.fileTypesTouched.push(ext);
					this.evolveTrait(p, 'specialist', 0); // more types = generalist
				}
			}
		}
	}

	/** A tool completed (result received) */
	onToolDone(runtimeId: number, toolName: string, wasRetry: boolean): void {
		const p = this.getP(runtimeId);
		if (!p) return;

		if (wasRetry) {
			p.stats.totalErrors++;
			this.setMood(p, MoodType.FRUSTRATED, 0.7, 'tool_retry');
			if (Math.random() < 0.5) this.addThought(p, 'tool_retry', MoodType.FRUSTRATED);
			this.evolveTrait(p, 'careful', 1); // errors make agents more careful
		}

		if (toolName === 'Bash:build' || toolName === 'Bash:test') {
			// We'll detect success/failure from the next events
			if (Math.random() < 0.3) this.addThought(p, 'testing', p.mood.current);
		}

		if (toolName === 'Task' || toolName === 'Agent') {
			this.setMood(p, MoodType.SATISFIED, 0.6, 'collab_complete');
			if (Math.random() < 0.4) this.addThought(p, 'collab_complete', MoodType.SATISFIED);
		}
	}

	/** Turn completed (turn_duration signal) */
	onTurnComplete(runtimeId: number, durationMs?: number): void {
		const p = this.getP(runtimeId);
		if (!p) return;

		p.stats.totalTurns++;
		if (durationMs !== undefined) {
			p.stats.turnDurations.push(durationMs);
			if (p.stats.turnDurations.length > MAX_TURN_DURATIONS) {
				p.stats.turnDurations.shift();
			}
			p.stats.activeTimeSec += durationMs / 1000;
		}

		// Determine completion mood based on turn characteristics
		const toolsThisTurn = p.stats.totalTools; // approximate
		const wasFrustrated = p.mood.current === MoodType.FRUSTRATED;
		const wasLong = durationMs !== undefined && durationMs > 60000;
		const wasComplex = toolsThisTurn > 10;

		if (wasComplex || wasLong) {
			this.setMood(p, MoodType.ACCOMPLISHED, 0.9, 'turn_complete');
		} else if (wasFrustrated) {
			// Completing despite frustration → relief + satisfaction
			this.setMood(p, MoodType.SATISFIED, 0.7, 'turn_complete');
		} else {
			this.setMood(p, MoodType.SATISFIED, 0.6, 'turn_complete');
		}

		this.addThought(p, 'turn_complete', p.mood.current);

		// Check for tiredness (long active time)
		if (p.stats.activeTimeSec > 1800) { // 30+ minutes active
			if (Math.random() < 0.3) {
				this.setMood(p, MoodType.TIRED, 0.4, 'long_session');
			}
		}

		this.scheduleSave();
	}

	/** Permission wait started */
	onPermissionWait(runtimeId: number): void {
		const p = this.getP(runtimeId);
		if (!p) return;
		// Only show impatience after a brief delay (handled by caller)
		this.setMood(p, MoodType.IMPATIENT, 0.5, 'permission_wait');
		if (Math.random() < 0.4) this.addThought(p, 'permission_wait', p.mood.current);
	}

	/** Agent has been idle for a while */
	onIdle(runtimeId: number): void {
		const p = this.getP(runtimeId);
		if (!p) return;

		if (p.stats.activeTimeSec > 1200) { // 20+ minutes active before idle
			this.setMood(p, MoodType.TIRED, 0.5, 'idle');
		} else {
			this.setMood(p, MoodType.RELAXED, 0.5, 'idle');
		}
		if (Math.random() < 0.2) this.addThought(p, 'idle', p.mood.current);
	}

	/** Periodic tick — decay moods toward neutral */
	tick(dt: number): void {
		const now = Date.now();
		for (const p of this.personalities.values()) {
			if (p.mood.current === MoodType.NEUTRAL) continue;

			const elapsed = now - p.mood.since;
			const decayTime = MOOD_DECAY_TIMES[p.mood.current] * 1000;
			if (elapsed > decayTime) {
				// Mood has fully decayed
				p.mood.intensity *= 0.95;
				if (p.mood.intensity < 0.1) {
					this.setMood(p, MoodType.NEUTRAL, 0, 'decay');
				}
			} else {
				// Gradual intensity decay
				const progress = elapsed / decayTime;
				p.mood.intensity = p.mood.intensity * (1 - progress * 0.01 * dt);
			}
		}
	}

	// ── Internal helpers ────────────────────────────────────

	private getP(runtimeId: number): AgentPersonality | undefined {
		return this.getPersonality(runtimeId);
	}

	private setMood(p: AgentPersonality, mood: MoodType, intensity: number, trigger: string): void {
		// Don't downgrade a stronger mood with a weaker one of similar type
		if (p.mood.current === mood && p.mood.intensity > intensity) return;

		p.mood.current = mood;
		p.mood.intensity = Math.min(1, intensity);
		p.mood.since = Date.now();

		// Track valence history
		p.mood.recentValences.push(MOOD_VALENCE[mood]);
		if (p.mood.recentValences.length > MAX_RECENT_VALENCES) {
			p.mood.recentValences.shift();
		}

		// Add to mood history for graphs
		p.moodHistory.push([Date.now(), mood, intensity, trigger]);
		if (p.moodHistory.length > MAX_MOOD_HISTORY) {
			p.moodHistory.shift();
		}
	}

	private timeSinceMood(p: AgentPersonality): number {
		return Date.now() - p.mood.since;
	}

	private addThought(p: AgentPersonality, trigger: string, mood: MoodType | string): void {
		const key = `${trigger}:${mood}`;
		const templates = THOUGHT_TEMPLATES[key] || THOUGHT_TEMPLATES[`${trigger}:neutral`];
		if (!templates || templates.length === 0) return;

		const text = templates[Math.floor(Math.random() * templates.length)];

		// Don't repeat the exact same thought consecutively
		if (p.thoughts.length > 0 && p.thoughts[0].text === text) return;

		p.thoughts.unshift({
			text,
			mood: mood as MoodType,
			timestamp: Date.now(),
			trigger,
		});

		if (p.thoughts.length > MAX_THOUGHTS) {
			p.thoughts.pop();
		}
	}

	private evolveTrait(p: AgentPersonality, trait: keyof PersonalityTraits, direction: 0 | 1): void {
		const target = direction; // 0 or 1
		const current = p.traits[trait];
		p.traits[trait] = current + (target - current) * TRAIT_LEARNING_RATE;
	}

	// ── Persistence ─────────────────────────────────────────

	private scheduleSave(): void {
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.save();
		}, 5000);
	}

	private save(): void {
		try {
			const data: Record<string, unknown> = {};
			for (const [key, p] of this.personalities) {
				data[key] = {
					agentKey: p.agentKey,
					name: p.name,
					mood: p.mood,
					traits: p.traits,
					thoughts: p.thoughts.slice(0, MAX_THOUGHTS),
					relationships: p.relationships,
					stats: {
						...p.stats,
						fileTypesTouched: [...p.stats.fileTypesTouched],
					},
					moodHistory: p.moodHistory.slice(-MAX_MOOD_HISTORY),
				};
			}
			fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
		} catch (err) {
			console.warn(`[Personality] Failed to save: ${err}`);
		}
	}

	private load(): void {
		try {
			if (!fs.existsSync(this.persistPath)) return;
			const raw = JSON.parse(fs.readFileSync(this.persistPath, 'utf-8'));
			for (const [key, data] of Object.entries(raw)) {
				const d = data as Record<string, unknown>;
				const p = createDefaultPersonality(key, (d.name as string) || key);

				// Restore mood
				if (d.mood && typeof d.mood === 'object') {
					const m = d.mood as Record<string, unknown>;
					p.mood.current = (m.current as MoodType) || MoodType.NEUTRAL;
					p.mood.intensity = (m.intensity as number) || 0;
					p.mood.since = (m.since as number) || Date.now();
					p.mood.recentValences = Array.isArray(m.recentValences) ? m.recentValences as number[] : [];
				}

				// Restore traits
				if (d.traits && typeof d.traits === 'object') {
					Object.assign(p.traits, d.traits);
				}

				// Restore thoughts
				if (Array.isArray(d.thoughts)) {
					p.thoughts = (d.thoughts as Thought[]).slice(0, MAX_THOUGHTS);
				}

				// Restore relationships
				if (Array.isArray(d.relationships)) {
					p.relationships = d.relationships as Relationship[];
				}

				// Restore stats
				if (d.stats && typeof d.stats === 'object') {
					const s = d.stats as Record<string, unknown>;
					Object.assign(p.stats, s);
					if (Array.isArray(s.fileTypesTouched)) {
						p.stats.fileTypesTouched = s.fileTypesTouched as string[];
					}
				}

				// Restore mood history
				if (Array.isArray(d.moodHistory)) {
					p.moodHistory = d.moodHistory as Array<[number, MoodType, number, string]>;
				}

				this.personalities.set(key, p);
			}
			console.log(`[Personality] Loaded ${this.personalities.size} agent personalities from ${this.persistPath}`);
		} catch (err) {
			console.warn(`[Personality] Failed to load: ${err}`);
		}
	}

	/** Force save (e.g., on deactivate) */
	flush(): void {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		this.save();
	}

	// ── Serialization for webview ───────────────────────────

	/** Get a serializable snapshot of all personalities for the webview */
	getSnapshot(): Record<string, SerializedPersonality> {
		const result: Record<string, SerializedPersonality> = {};
		for (const [key, p] of this.personalities) {
			result[key] = {
				agentKey: p.agentKey,
				name: p.name,
				mood: {
					current: p.mood.current,
					intensity: p.mood.intensity,
				},
				traits: { ...p.traits },
				latestThought: p.thoughts.length > 0 ? p.thoughts[0] : null,
				recentThoughts: p.thoughts.slice(0, 10),
				relationships: p.relationships,
				moodHistory: p.moodHistory.slice(-50),
				averageSentiment: p.mood.recentValences.length > 0
					? p.mood.recentValences.reduce((a, b) => a + b, 0) / p.mood.recentValences.length
					: 0,
				stats: {
					totalTurns: p.stats.totalTurns,
					totalTools: p.stats.totalTools,
					activeTimeSec: p.stats.activeTimeSec,
					topTools: Object.entries(p.stats.toolCounts)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 5)
						.map(([name, count]) => ({ name, count })),
				},
			};
		}
		return result;
	}
}

export interface SerializedPersonality {
	agentKey: string;
	name: string;
	mood: { current: MoodType; intensity: number };
	traits: PersonalityTraits;
	latestThought: Thought | null;
	recentThoughts: Thought[];
	relationships: Relationship[];
	moodHistory: Array<[number, MoodType, number, string]>;
	averageSentiment: number;
	stats: {
		totalTurns: number;
		totalTools: number;
		activeTimeSec: number;
		topTools: Array<{ name: string; count: number }>;
	};
}

// ── Module-level accessor (avoids threading engine through all callers) ──

let _engine: PersonalityEngine | null = null;

/** Set the active personality engine instance (called once at startup) */
export function setPersonalityEngine(engine: PersonalityEngine): void { _engine = engine; }

/** Get the active personality engine (returns null before init) */
export function getPersonalityEngine(): PersonalityEngine | null { return _engine; }

// ── Factory ─────────────────────────────────────────────────

function createDefaultPersonality(agentKey: string, name: string): AgentPersonality {
	return {
		agentKey,
		name,
		mood: {
			current: MoodType.NEUTRAL,
			intensity: 0,
			since: Date.now(),
			recentValences: [],
		},
		traits: {
			methodical: 0.5,
			collaborative: 0.5,
			careful: 0.5,
			specialist: 0.5,
		},
		thoughts: [],
		relationships: [],
		stats: {
			totalTools: 0,
			toolCounts: {},
			totalTurns: 0,
			totalErrors: 0,
			totalSubagents: 0,
			turnDurations: [],
			fileTypesTouched: [],
			sessionStartTime: Date.now(),
			activeTimeSec: 0,
		},
		moodHistory: [],
	};
}
