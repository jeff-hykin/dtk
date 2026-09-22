#!/usr/bin/env python3
"""Send loco commands to a Unitree G1 over DDS.

Talks straight to the robot's loco service with unitree_sdk2py — no dimos
blueprint has to be running, and nothing gets compiled. Run it onboard the
Jetson, or from a machine plugged into the robot's own 192.168.123.x LAN.

The sequence the actions below drive is the one the physical remote does, and
the one the G1 Dash's C++ helper ports:

    ai motion service  ->  damp (FSM 1)  ->  stiffen (FSM 4)  ->  held R2+A

`SetFsmId(801)` is silently refused by the loco service, so the advanced
controller — the one that walks naturally — can only be entered by emulating a
held R2+A on `rt/wirelesscontroller`, exactly as the remote sends it.

The default action is `status`, which reads and changes nothing: every action
that moves a humanoid should have to be asked for by name.
"""

import argparse
import sys
import time

from unitree_sdk2py.comm.motion_switcher.motion_switcher_client import MotionSwitcherClient
from unitree_sdk2py.core.channel import ChannelFactoryInitialize, ChannelPublisher
from unitree_sdk2py.g1.loco.g1_loco_client import LocoClient
from unitree_sdk2py.idl.default import unitree_go_msg_dds__WirelessController_
from unitree_sdk2py.idl.unitree_go.msg.dds_ import WirelessController_

# Controller equivalents: L2+B -> damp, L2+Up -> stiffen/get-ready, R2+A -> advanced.
FSM_ZERO_TORQUE = 0
FSM_DAMP = 1
FSM_SIT = 3
FSM_STIFFEN = 4
FSM_BASIC_BALANCE = 200
FSM_LIE_TO_STAND = 702
FSM_ADVANCED_ENTRY = 801
FSM_ADVANCED_ACTIVE = 802

# rt/wirelesscontroller key bits, as the physical remote sends them.
KEY_R2 = 1 << 4
KEY_A = 1 << 8
COMBO_HOLD_SEC = 1.5
COMBO_RELEASE_SEC = 0.3
COMBO_RATE_HZ = 20

# The FSM ignores SetFsmId while a transition is still in flight, so re-send
# until the reported id matches rather than sleeping a guessed amount.
STEP_TIMEOUT_SEC = 15
STEP_POLL_SEC = 1

# The default sport controller walks with a stompy gait; "ai" is the natural one.
MOTION_MODE = "ai"
MODE_TIMEOUT_SEC = 10

# eth0 is the robot's own 192.168.123.x DDS interface when this runs onboard.
DEFAULT_INTERFACE = "eth0"

FSM_NAMES = {
    FSM_ZERO_TORQUE: "limp (zero torque)",
    FSM_DAMP: "damp",
    FSM_SIT: "sit",
    FSM_STIFFEN: "stiffen (get-ready)",
    FSM_BASIC_BALANCE: "basic balance",
    FSM_LIE_TO_STAND: "getting up",
    FSM_ADVANCED_ENTRY: "advanced (entering)",
    FSM_ADVANCED_ACTIVE: "advanced (active)",
}


def describe_fsm(fsm_id):
    return f"{fsm_id} — {FSM_NAMES[fsm_id]}" if fsm_id in FSM_NAMES else str(fsm_id)


class G1:
    def __init__(self, interface):
        ChannelFactoryInitialize(0, interface)
        self.loco = LocoClient()
        self.loco.SetTimeout(10.0)
        self.loco.Init()
        self.switcher = MotionSwitcherClient()
        self.switcher.SetTimeout(10.0)
        self.switcher.Init()
        self.wireless = ChannelPublisher("rt/wirelesscontroller", WirelessController_)
        self.wireless.Init()

    def fsm_id(self):
        code, value = self.loco.GetFsmId()
        return int(value) if code == 0 else -1

    def motion_mode(self):
        code, status = self.switcher.CheckMode()
        if code != 0 or not isinstance(status, dict):
            return "?"
        return status.get("name") or "none"

    def step(self, label, target):
        """SetFsmId + re-poll until the loco service reports the id."""
        print(f"  {label}: -> FSM {target}", flush=True)
        deadline = time.monotonic() + STEP_TIMEOUT_SEC
        while time.monotonic() < deadline:
            code = self.loco.SetFsmId(target)
            if code != 0:
                print(f"    SetFsmId({target}) returned {code}", flush=True)
            time.sleep(STEP_POLL_SEC)
            if self.fsm_id() == target:
                print(f"  {label}: ok", flush=True)
                return True
        print(f"  {label}: TIMEOUT — still FSM {describe_fsm(self.fsm_id())}", flush=True)
        return False

    def press_combo(self, keys, seconds):
        message = unitree_go_msg_dds__WirelessController_()
        message.lx = message.ly = message.rx = message.ry = 0.0
        message.keys = keys
        tick = 1.0 / COMBO_RATE_HZ
        for _ in range(int(seconds * COMBO_RATE_HZ)):
            self.wireless.Write(message)
            time.sleep(tick)

    def engage_advanced(self):
        """The advanced controller can only be entered the way the remote does it."""
        print("  balance: holding R2+A", flush=True)
        deadline = time.monotonic() + STEP_TIMEOUT_SEC
        while time.monotonic() < deadline:
            self.press_combo(KEY_R2 | KEY_A, COMBO_HOLD_SEC)
            self.press_combo(0, COMBO_RELEASE_SEC)
            time.sleep(STEP_POLL_SEC)
            if self.fsm_id() in (FSM_ADVANCED_ENTRY, FSM_ADVANCED_ACTIVE):
                print("  balance: ok", flush=True)
                return True
        print(f"  balance: TIMEOUT — still FSM {describe_fsm(self.fsm_id())}", flush=True)
        return False

    def ensure_ai_mode(self):
        """Controllers may only be switched while damped."""
        mode = self.motion_mode()
        if mode == MOTION_MODE:
            return True
        print(f"  motion service: '{mode}' -> '{MOTION_MODE}'", flush=True)
        # With no mode resident there is no loco server to accept a damp, so skip it.
        if mode not in ("none", "?") and not self.step("damp", FSM_DAMP):
            return False
        code = self.switcher.SelectMode(MOTION_MODE)
        if code != 0:
            print(f"    SelectMode('{MOTION_MODE}') returned {code}", flush=True)
            return False
        deadline = time.monotonic() + MODE_TIMEOUT_SEC
        while time.monotonic() < deadline:
            if self.motion_mode() == MOTION_MODE:
                print("  motion service: ok", flush=True)
                return True
            time.sleep(0.5)
        print("  motion service: TIMEOUT", flush=True)
        return False


def main():
    parser = argparse.ArgumentParser(
        prog="dtk g1_cmd",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "action",
        nargs="?",
        default="status",
        choices=["status", "limp", "damp", "sit", "getup", "stiffen", "balance", "stand"],
        help=(
            "status: read the robot's mode, change nothing (default). "
            "limp: motors off. damp: joints compliant. sit: seated, balance off. "
            "getup: from flat on its back. stiffen: joints locked, legs straight, not balancing. "
            "balance: hold R2+A into the advanced controller, robot must already be stiffened. "
            "stand: stiffen then balance."
        ),
    )
    parser.add_argument(
        "--iface",
        default=DEFAULT_INTERFACE,
        help=f"network interface the robot's DDS is on (default {DEFAULT_INTERFACE})",
    )
    arguments = parser.parse_args()

    robot = G1(arguments.iface)
    print(
        f"start: FSM {describe_fsm(robot.fsm_id())}, motion service '{robot.motion_mode()}'",
        flush=True,
    )

    action = arguments.action
    if action == "status":
        return 0
    if action == "limp":
        ok = robot.step("limp", FSM_ZERO_TORQUE)
    elif action == "damp":
        ok = robot.step("damp", FSM_DAMP)
    elif action == "sit":
        ok = robot.step("sit", FSM_SIT)
    elif action == "getup":
        ok = robot.ensure_ai_mode() and robot.step("damp", FSM_DAMP) and robot.step("getup", FSM_LIE_TO_STAND)
    elif action == "stiffen":
        ok = robot.ensure_ai_mode() and robot.step("damp", FSM_DAMP) and robot.step("stiffen", FSM_STIFFEN)
    elif action == "balance":
        ok = robot.engage_advanced()
    else:
        ok = (
            robot.ensure_ai_mode()
            and robot.step("damp", FSM_DAMP)
            and robot.step("stiffen", FSM_STIFFEN)
            and robot.engage_advanced()
        )

    print(f"end: FSM {describe_fsm(robot.fsm_id())} — {'done' if ok else 'FAILED'}", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
