#!/usr/bin/env bash
# Builds the synthetic repository the README screenshots are taken against.
# Nothing here is real: the names and the subject matter are lifted from Deus Ex
# so the screenshots have plausible history to show without exposing anyone's.
set -euo pipefail

DEST=${1:?usage: make-demo-repo.sh <dir>}
rm -rf "$DEST"; mkdir -p "$DEST"; cd "$DEST"
git init -q -b main

commit() { # commit <author> <email> <date> <message>
  GIT_AUTHOR_NAME=$1 GIT_AUTHOR_EMAIL=$2 GIT_AUTHOR_DATE=$3 \
  GIT_COMMITTER_NAME=$1 GIT_COMMITTER_EMAIL=$2 GIT_COMMITTER_DATE=$3 \
  git commit -q --no-gpg-sign -m "$4"
}

JENSEN=(  "Adam Jensen"      "a.jensen@sarif.industries" )
PRITCH=(  "Frank Pritchard"  "f.pritchard@sarif.industries" )
MEGAN=(   "Megan Reed"       "m.reed@sarif.industries" )
MALIK=(   "Faridah Malik"    "f.malik@sarif.industries" )
SARIF=(   "David Sarif"      "d.sarif@sarif.industries" )
KOLLER=(  "Vaclav Koller"    "koller@zelen.prague" )
VEGA=(    "Alex Vega"        "a.vega@tf29.int" )
MILLER=(  "Jim Miller"       "j.miller@tf29.int" )

mkdir -p src/aug src/neural docs assets

cat > README.md <<'EOF'
# Sarif Augmentation Firmware

Firmware for the Sarif Series-3 augmentation bus: limb controllers, the
neural implant stack, and the diagnostics the clinic reads them with.
EOF
cat > docs/bus.md <<'EOF'
# The augmentation bus

Every implant is a node on a shared bus. Nodes announce themselves at power-on
and are polled on a fixed cadence; a node that stops answering is dropped and
its limb falls back to passive control.
EOF
git add -A; commit "${SARIF[@]}" "2026-04-02T09:12:00+00:00" "chore: start the series-3 firmware tree"

cat > src/aug/bus.rs <<'EOF'
//! The augmentation bus: implants announce themselves at power-on and are
//! polled on a fixed cadence. A node that stops answering is dropped and its
//! limb falls back to passive control, which is always safe if not useful.

use std::time::Duration;

pub const POLL_INTERVAL: Duration = Duration::from_millis(20);
pub const MISSED_POLL_LIMIT: u8 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NodeState {
    Announcing,
    Live { missed: u8 },
    Dropped,
}

impl NodeState {
    /// Advance a node one poll. A node that answers is fully forgiven: a single
    /// late reply on a noisy bus is not evidence of a failing implant.
    pub fn poll(self, answered: bool) -> Self {
        match (self, answered) {
            (NodeState::Dropped, _) => NodeState::Dropped,
            (_, true) => NodeState::Live { missed: 0 },
            (NodeState::Live { missed }, false) if missed + 1 >= MISSED_POLL_LIMIT => {
                NodeState::Dropped
            }
            (NodeState::Live { missed }, false) => NodeState::Live { missed: missed + 1 },
            (NodeState::Announcing, false) => NodeState::Announcing,
        }
    }
}
EOF
git add -A; commit "${PRITCH[@]}" "2026-04-06T14:40:00+00:00" "feat(bus): poll implants and drop the ones that stop answering

A limb that has lost its controller should go passive rather than hold
its last command, so track missed polls per node and drop at three. One
late reply on a noisy bus clears the count: a single miss is not evidence
of a failing implant."

cat > src/neural/infolink.ts <<'EOF'
/// InfoLink: the low-bandwidth channel every implant shares for status.
///
/// Messages are small and frequent, so they are batched into one frame per
/// poll rather than sent as they arrive. A frame that would overflow is split
/// and the remainder carried to the next poll.

export interface Message {
  node: number;
  kind: "status" | "alarm" | "telemetry";
  body: string;
}

const FRAME_BYTES = 240;

export function pack(queue: Message[]): { frame: Message[]; rest: Message[] } {
  const frame: Message[] = [];
  let used = 0;
  for (let i = 0; i < queue.length; i++) {
    const size = queue[i].body.length + 4;
    // An alarm is never held back for want of room: drop telemetry instead.
    if (used + size > FRAME_BYTES && queue[i].kind !== "alarm") {
      return { frame, rest: queue.slice(i) };
    }
    frame.push(queue[i]);
    used += size;
  }
  return { frame, rest: [] };
}
EOF
git add -A; commit "${MEGAN[@]}" "2026-04-21T11:05:00+00:00" "feat(infolink): batch implant status into one frame per poll

Status messages are small and constant, and sending each as it arrives
spent more of the channel on headers than on content. Batch them per poll
instead. An alarm is never held back for want of room - telemetry gives
up its place first."

cat > src/aug/typhoon.rs <<'EOF'
//! Typhoon: the explosive discharge system. Arming is deliberately awkward.

use crate::aug::bus::NodeState;

/// Rounds are physical and cannot be reclaimed, so arming needs both hands
/// clear of the bus and an explicit confirmation from the wearer.
pub struct Typhoon {
    rounds: u8,
    armed: bool,
}

impl Typhoon {
    pub fn arm(&mut self, limbs: &[NodeState], confirmed: bool) -> Result<(), &'static str> {
        if !confirmed {
            return Err("arming needs the wearer's confirmation");
        }
        if limbs.iter().any(|l| *l == NodeState::Dropped) {
            return Err("a dropped limb cannot be cleared of the discharge");
        }
        if self.rounds == 0 {
            return Err("no rounds loaded");
        }
        self.armed = true;
        Ok(())
    }
}
EOF
git add -A; commit "${JENSEN[@]}" "2026-05-08T16:22:00+00:00" "feat(typhoon): refuse to arm while a limb is unaccounted for

The discharge is spherical and the wearer's own limbs are inside it. If a
limb has dropped off the bus there is no way to know where it is, so
arming fails rather than guessing."

# A logo, so the screenshots show an image rendered in place.
python3 - <<'PY'
import zlib, struct, math
W = H = 96
px = bytearray()
for y in range(H):
    px.append(0)
    for x in range(W):
        dx, dy = x - W/2 + .5, y - H/2 + .5
        d = math.hypot(dx, dy)
        ring = abs(d - 30) < 5 or abs(d - 20) < 3
        spoke = abs(dx) < 3 and dy < 0 and d < 34
        if ring or spoke:
            px += bytes((222, 170, 66))
        elif d < 38:
            px += bytes((22, 20, 16))
        else:
            px += bytes((12, 11, 10))
def chunk(t, d):
    c = t + d
    return struct.pack(">I", len(d)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
open("assets/sarif-mark.png", "wb").write(
    b"\x89PNG\r\n\x1a\n"
    + chunk(b"IHDR", struct.pack(">IIBBBBB", W, H, 8, 2, 0, 0, 0))
    + chunk(b"IDAT", zlib.compress(bytes(px), 9))
    + chunk(b"IEND", b""))
PY
git add -A; commit "${SARIF[@]}" "2026-05-14T08:30:00+00:00" "docs: add the company mark to the clinic diagnostics splash"

cat > src/neural/casie.ts <<'EOF'
/// CASIE: reads vocal stress and pupil response and reports a bias, never a
/// verdict. The wearer is told what was measured, not what to conclude.

export interface Reading {
  stressHz: number;
  pupilMm: number;
  baselineMm: number;
}

export type Bias = "alpha" | "beta" | "omega" | "unclear";

/// A reading too close to the wearer's own baseline is reported as unclear
/// rather than rounded to the nearest profile: a confident wrong answer here
/// is worse than no answer.
export function classify(r: Reading): Bias {
  const delta = r.pupilMm - r.baselineMm;
  if (Math.abs(delta) < 0.15) return "unclear";
  if (r.stressHz > 240 && delta > 0) return "alpha";
  if (r.stressHz < 120 && delta < 0) return "omega";
  return "beta";
}
EOF
git add -A; commit "${KOLLER[@]}" "2026-06-02T19:47:00+00:00" "feat(casie): report an unclear reading rather than guess a profile

Near the wearer's own baseline the profiles are indistinguishable, and
rounding to the nearest one produced confident nonsense. Say unclear
instead: no answer is easier to act on than a wrong one."

sed -i 's/pub const MISSED_POLL_LIMIT: u8 = 3;/pub const MISSED_POLL_LIMIT: u8 = 4;/' src/aug/bus.rs
git add -A; commit "${MALIK[@]}" "2026-06-19T10:15:00+00:00" "fix(bus): allow one more missed poll before dropping a limb

Three polls is 60ms, and the flight harness alone induces enough noise to
cross it during a hard landing. Four costs nothing that matters and stops
the leg going passive on approach."

# --- a feature branch, for the review view -------------------------------
git checkout -q -b feat/icarus-landing-system
cat > src/aug/icarus.rs <<'EOF'
//! The Icarus landing system: bleeds a fall's energy into the ground rather
//! than into the wearer's legs.

use std::time::Duration;

/// Below this there is nothing to bleed and firing costs more than the fall.
pub const MIN_DEPLOY_M: f32 = 3.0;
/// The knees give out past this whatever the system does; deploy anyway.
pub const SURVIVABLE_M: f32 = 24.0;

pub struct Descent {
    pub height_m: f32,
    pub velocity_ms: f32,
}

impl Descent {
    /// How long the field must hold to land the wearer at a walking pace.
    ///
    /// Deliberately not a function of height alone: a fall arrested part way
    /// down and resumed is common on a stairwell, and the velocity is what the
    /// knees actually feel.
    pub fn hold_for(&self) -> Option<Duration> {
        if self.height_m < MIN_DEPLOY_M {
            return None;
        }
        let target = 1.4_f32;
        let excess = (self.velocity_ms - target).max(0.0);
        Some(Duration::from_millis((excess * 38.0) as u64))
    }
}
EOF
git add -A; commit "${PRITCH[@]}" "2026-07-01T13:20:00+00:00" "feat(icarus): bleed a descent by velocity rather than height

A fall arrested part way down and resumed is ordinary on a stairwell, and
sizing the field by the drop height overshoots badly on the second half.
The knees feel velocity, so hold for that instead."

cat >> src/aug/icarus.rs <<'EOF'

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_short_step_does_not_deploy() {
        let d = Descent { height_m: 1.2, velocity_ms: 4.0 };
        assert_eq!(d.hold_for(), None);
    }

    #[test]
    fn a_walking_pace_landing_needs_no_hold() {
        let d = Descent { height_m: 6.0, velocity_ms: 1.4 };
        assert_eq!(d.hold_for(), Some(Duration::ZERO));
    }
}
EOF
git add -A; commit "${JENSEN[@]}" "2026-07-03T09:05:00+00:00" "test(icarus): cover the step and the walking-pace landing"

cat > docs/icarus.md <<'EOF'
# Icarus

The system fires below the wearer and holds a field for as long as the descent
needs, sized by velocity rather than by the height fallen. It does not decide
whether a fall is survivable: past the point where the knees give out it
deploys anyway, on the grounds that the alternative is worse.
EOF
git add -A; commit "${MALIK[@]}" "2026-07-08T15:41:00+00:00" "docs(icarus): write down why the system deploys past the survivable drop"

# --- a second branch off main -------------------------------------------
git checkout -q main
git checkout -q -b fix/neuropozyne-dosing
cat > src/neural/dosing.ts <<'EOF'
/// Neuropozyne dosing. The schedule is the patient's, not the clinic's: a dose
/// missed by hours is corrected toward the original schedule, never stacked on
/// the next one.

export interface Dose {
  atMinutes: number;
  microgram: number;
}

const MAX_CATCHUP = 0.25;

export function reschedule(planned: Dose[], missedAt: number): Dose[] {
  return planned.map((d) =>
    d.atMinutes <= missedAt
      ? d
      : { ...d, microgram: d.microgram * (1 + MAX_CATCHUP) },
  );
}
EOF
git add -A; commit "${MEGAN[@]}" "2026-07-15T12:00:00+00:00" "fix(dosing): spread a missed dose instead of stacking it

Stacking a missed dose onto the next one puts the patient over the
tolerated ceiling for a full cycle. Spread the shortfall across what is
left of the schedule, capped at a quarter, and let the rest go."

git checkout -q main
cat > src/aug/diagnostics.rs <<'EOF'
//! What the clinic reads out of an implant. Everything here is the wearer's to
//! see: there is no field the firmware records and refuses to show.

use crate::aug::bus::NodeState;

pub struct Readout {
    pub node: u16,
    pub state: NodeState,
    pub rejection_index: f32,
    pub firmware: &'static str,
}

pub fn summarise(nodes: &[Readout]) -> String {
    let dropped = nodes.iter().filter(|n| n.state == NodeState::Dropped).count();
    match dropped {
        0 => format!("{} nodes live", nodes.len()),
        n => format!("{} of {} nodes dropped", n, nodes.len()),
    }
}
EOF
git add -A; commit "${VEGA[@]}" "2026-08-04T17:30:00+00:00" "feat(diagnostics): summarise the bus for the clinic readout"

sed -i 's/pub firmware: &.static str,/pub firmware: \&'"'"'static str,\n    pub last_seen_minutes: u32,/' src/aug/diagnostics.rs
git add -A; commit "${MILLER[@]}" "2026-08-18T11:52:00+00:00" "feat(diagnostics): record when a node was last seen

A dropped node says nothing about when it went, which is the first thing
the clinic asks."

sed -i 's/pub const POLL_INTERVAL: Duration = Duration::from_millis(20);/pub const POLL_INTERVAL: Duration = Duration::from_millis(25);/' src/aug/bus.rs
sed -i 's/pub const MISSED_POLL_LIMIT: u8 = 4;/pub const MISSED_POLL_LIMIT: u8 = 6;/' src/aug/bus.rs
sed -i 's/if limbs.iter().any(|l| \*l == NodeState::Dropped) {/if limbs.iter().any(NodeState::is_dropped) {/' src/aug/typhoon.rs
sed -i 's/let dropped = nodes.iter().filter(|n| n.state == NodeState::Dropped).count();/let dropped = nodes.iter().filter(|n| n.state.is_dropped()).count();/' src/aug/diagnostics.rs
cat >> src/aug/bus.rs <<'EOF'

impl NodeState {
    /// Whether the node has stopped answering for good.
    pub fn is_dropped(&self) -> bool {
        matches!(self, NodeState::Dropped)
    }
}
EOF
sed -i 's/its limb falls back to passive control./its limb falls back to passive control. The poll cadence is deliberately slow:\nthe bus is shared, and a limb that answers late is not a limb that has failed./' docs/bus.md
git add -A; commit "${JENSEN[@]}" "2026-08-25T09:18:00+00:00" "refactor(bus): ask a node whether it has dropped rather than matching it

Three places compared against NodeState::Dropped by hand, which is a
detail of the enum leaking into everything that reads one. Give the state
the question instead.

The cadence goes out to 25ms and the limit to six polls while the shape
of this is being changed: the bus is shared, and answering late is not
the same as having failed."

git checkout -q main
