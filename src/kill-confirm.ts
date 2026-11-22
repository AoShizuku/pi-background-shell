// Two-step kill (DESIGN.md §3.8): the first x arms the selected task, a second x on it kills it. The /background
// list and the detail overlay each have their own instance. pi-subagent has the same state machine for x stop.
//
// The arm belongs to a task id, never to a row index: a second x must not land on whatever task is in the
// armed row by then. It is dropped as soon as that task is no longer the selected, killable one.

export const ARMED_HINT = "press x again to kill · any other key cancels";

export class KillConfirm {
	private armed: string | undefined;

	/** `enabled` is read on every press. */
	constructor(private readonly enabled: () => boolean) {}

	isArmed(id: string | undefined): boolean {
		return id !== undefined && this.armed === id;
	}

	/** x on a killable task. True: kill it now. False: it is armed and waits for the second x. */
	press(id: string): boolean {
		if (!this.enabled() || this.armed === id) {
			this.armed = undefined;
			return true;
		}
		this.armed = id;
		return false;
	}

	/** Disarm; true when something was armed. */
	cancel(): boolean {
		if (this.armed === undefined) return false;
		this.armed = undefined;
		return true;
	}

	/** Keep the arm only while `selectedId` is the armed task and it can still be killed. True when it disarmed. */
	keep(selectedId: string | undefined, killable: boolean): boolean {
		if (this.armed === undefined || (this.armed === selectedId && killable)) return false;
		this.armed = undefined;
		return true;
	}
}
