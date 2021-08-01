import Clutter from '@gi-types/clutter';
import GObject from '@gi-types/gobject';
import Shell from '@gi-types/shell';
import Meta from '@gi-types/meta';
import { imports, global, CustomEventType } from 'gnome-shell';

const Main = imports.ui.main;
const { SwipeTracker } = imports.ui.swipeTracker;

import * as DBusUtils from './utils/dbus';
import { TouchpadConstants } from '../constants';

const TouchpadState = {
	NONE: 0,
	PENDING: 1,
	HANDLING: 2,
	IGNORED: 3,
};

export const TouchpadSwipeGesture = GObject.registerClass({
	Properties: {
		'enabled': GObject.ParamSpec.boolean(
			'enabled', 'enabled', 'enabled',
			GObject.ParamFlags.READWRITE,
			true),
		'orientation': GObject.ParamSpec.enum(
			'orientation', 'orientation', 'orientation',
			GObject.ParamFlags.READWRITE,
			Clutter.Orientation, Clutter.Orientation.HORIZONTAL),
	},
	Signals: {
		'begin': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE] },
		'update': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE] },
		'end': { param_types: [GObject.TYPE_UINT, GObject.TYPE_DOUBLE] },
	},
}, class TouchpadSwipeGesture extends GObject.Object {
	private _nfingers: number[];
	private _allowedModes: Shell.ActionMode;
	orientation: Clutter.Orientation;
	private _state: number;
	private _checkAllowedGesture?: (event: CustomEventType) => boolean;
	private _cumulativeX = 0;
	private _cumulativeY = 0;
	private _followNaturalScroll: boolean;
	private _stageCaptureEvent = 0;
	private _toggledDirection = false;
	SWIPE_MULTIPLIER: number;
	TOUCHPAD_BASE_HEIGHT = TouchpadConstants.TOUCHPAD_BASE_HEIGHT;
	TOUCHPAD_BASE_WIDTH = TouchpadConstants.TOUCHPAD_BASE_WIDTH;
	DRAG_THRESHOLD_DISTANCE = TouchpadConstants.DRAG_THRESHOLD_DISTANCE;
	enabled = true;

	constructor(
		nfingers: number[],
		allowedModes: Shell.ActionMode,
		orientation: Clutter.Orientation,
		followNaturalScroll = true,
		checkAllowedGesture = undefined,
		gestureSpeed = 1.0) {
		super();
		this._nfingers = nfingers;
		this._allowedModes = allowedModes;
		this.orientation = orientation;
		this._state = TouchpadState.NONE;
		this._checkAllowedGesture = checkAllowedGesture;
		this._followNaturalScroll = followNaturalScroll;
		if (Meta.is_wayland_compositor()) {
			this._stageCaptureEvent = global.stage.connect('captured-event::touchpad', this._handleEvent.bind(this));
		} else {
			DBusUtils.subscribe(this._handleEvent.bind(this));
		}

		this.SWIPE_MULTIPLIER = TouchpadConstants.SWIPE_MULTIPLIER * (typeof (gestureSpeed) !== 'number' ? 1.0 : gestureSpeed);
	}

	_handleEvent(_actor: undefined | Clutter.Actor, event: CustomEventType): boolean {
		// log(`swipe multiplier = ${this.SWIPE_MULTIPLIER}`);
		if (event.type() !== Clutter.EventType.TOUCHPAD_SWIPE)
			return Clutter.EVENT_PROPAGATE;

		if ((this._allowedModes !== Shell.ActionMode.ALL) && ((this._allowedModes & Main.actionMode) === 0))
			return Clutter.EVENT_PROPAGATE;

		if (!this._nfingers.includes(event.get_touchpad_gesture_finger_count()))
			return Clutter.EVENT_PROPAGATE;

		if (event.get_gesture_phase() === Clutter.TouchpadGesturePhase.BEGIN) {
			this._state = TouchpadState.NONE;
			this._toggledDirection = false;
		}

		if (this._state === TouchpadState.IGNORED)
			return Clutter.EVENT_PROPAGATE;

		if (!this.enabled)
			return Clutter.EVENT_PROPAGATE;

		if (this._state === TouchpadState.NONE && this._checkAllowedGesture !== undefined) {
			try {
				if (this._checkAllowedGesture(event) !== true) {
					return Clutter.EVENT_PROPAGATE;
				}
			}
			catch (ex) {
				return Clutter.EVENT_PROPAGATE;
			}
		}

		const time = event.get_time();

		const [x, y] = event.get_coords();
		const [dx, dy] = event.get_gesture_motion_delta_unaccelerated();

		if (this._state === TouchpadState.NONE) {
			if (dx === 0 && dy === 0)
				return Clutter.EVENT_PROPAGATE;

			this._cumulativeX = 0;
			this._cumulativeY = 0;
			this._state = TouchpadState.PENDING;
		}

		if (this._state === TouchpadState.PENDING) {
			this._cumulativeX += dx * this.SWIPE_MULTIPLIER;
			this._cumulativeY += dy * this.SWIPE_MULTIPLIER;

			const cdx = this._cumulativeX;
			const cdy = this._cumulativeY;
			const distance = Math.sqrt(cdx * cdx + cdy * cdy);

			if (distance >= this.DRAG_THRESHOLD_DISTANCE) {
				const gestureOrientation = Math.abs(cdx) > Math.abs(cdy)
					? Clutter.Orientation.HORIZONTAL
					: Clutter.Orientation.VERTICAL;

				this._cumulativeX = 0;
				this._cumulativeY = 0;

				if (gestureOrientation === this.orientation) {
					this._state = TouchpadState.HANDLING;
					this.emit('begin', time, x, y);
				} else {
					this._state = TouchpadState.IGNORED;
					return Clutter.EVENT_PROPAGATE;
				}
			} else {
				return Clutter.EVENT_PROPAGATE;
			}
		}

		const vertical = this.orientation === Clutter.Orientation.VERTICAL;
		let delta = ((vertical !== this._toggledDirection) ? dy : dx) * this.SWIPE_MULTIPLIER;
		const distance = vertical ? this.TOUCHPAD_BASE_HEIGHT : this.TOUCHPAD_BASE_WIDTH;

		switch (event.get_gesture_phase()) {
		case Clutter.TouchpadGesturePhase.BEGIN:
		case Clutter.TouchpadGesturePhase.UPDATE:
			if (this._followNaturalScroll)
				delta = -delta;

			this.emit('update', time, delta, distance);
			break;

		case Clutter.TouchpadGesturePhase.END:
		case Clutter.TouchpadGesturePhase.CANCEL:
			this.emit('end', time, distance);
			this._state = TouchpadState.NONE;
			this._toggledDirection = false;
			break;
		}

		return this._state === TouchpadState.HANDLING
			? Clutter.EVENT_STOP
			: Clutter.EVENT_PROPAGATE;
	}

	switchDirectionTo(direction: Clutter.Orientation): void {
		if (this._state !== TouchpadState.HANDLING) {
			return;
		}

		this._toggledDirection = direction !== this.orientation;
	}

	destroy() {
		if (this._stageCaptureEvent) {
			global.stage.disconnect(this._stageCaptureEvent);
			this._stageCaptureEvent = 0;
		}
	}
});


export function createSwipeTracker(
	actor: Clutter.Actor,
	nfingers: number[],
	allowedModes: Shell.ActionMode,
	orientation: Clutter.Orientation
): typeof SwipeTracker.prototype {
	// create swipeTracker
	const swipeTracker = new SwipeTracker(
		actor,
		orientation,
		allowedModes,
		{ allowDrag: false, allowScroll: false }
	);

	// remove old touchpad gesture from swipeTracker
	if (swipeTracker._touchpadGesture) {
		swipeTracker._touchpadGesture.destroy();
		swipeTracker._touchpadGesture = null;
	}

	// add touchpadBindings to tracker
	swipeTracker._touchpadGesture = new TouchpadSwipeGesture(
		nfingers,
		swipeTracker._allowedModes,
		swipeTracker.orientation,
		true);
	swipeTracker._touchpadGesture.connect('begin', swipeTracker._beginGesture.bind(swipeTracker));
	swipeTracker._touchpadGesture.connect('update', swipeTracker._updateGesture.bind(swipeTracker));
	swipeTracker._touchpadGesture.connect('end', swipeTracker._endTouchpadGesture.bind(swipeTracker));
	swipeTracker.bind_property('enabled', swipeTracker._touchpadGesture, 'enabled', 0);
	swipeTracker.bind_property('orientation', swipeTracker._touchpadGesture, 'orientation',
		GObject.BindingFlags.SYNC_CREATE);
	return swipeTracker;
}