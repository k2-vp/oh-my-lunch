# Fairness

A plinko board makes a terrible randomizer and a great show. Real plinko physics is not uniform: center lanes catch far more balls than edge lanes, and anyone who watched for a week would learn to put their favorite spot in the middle. This board refuses to let the physics decide.

## The order of events

For every ball, in this order:

1. **The draw.** The winner's lane is drawn uniformly at random from the lanes still in play. Every open lane has exactly the same chance. This is the decision, and it is over before anything moves.
2. **The search.** The simulator runs the deterministic physics for one candidate seed after another, and keeps the first path that comes to rest in the drawn lane.
3. **The show.** The board animates that path. The bounces you watch are real simulated physics, but they are a replay of a decision already made, the way a lottery machine's ping-pong balls are a show for numbers a computer could print in a millisecond.

So the ball cannot drift toward the middle, favor a lane, or be nudged by anyone. The lane was chosen by a flat draw, and the physics was selected to get there.

## What the tests prove

The suite does not take this on faith:

- A tally over millions of draws confirms that every open lane wins at the same rate.
- An eligibility proof confirms that spent and rejected lanes never win.
- A selection proof runs the seed search for every lane of every board size and confirms that a path is found and that it rests where the draw said.
- Tie handling gets its own proof: the deciding ball is drawn from the tied lanes only, with every other lane physically capped shut.

Run all of it with `npm test`.

## Lane closure is geometry, not paint

When a lane is out of play, the board does not just dim it. The lane's opening gets a cap, a solid piece of geometry, and the simulation runs against the capped board. A closed lane cannot receive a ball because there is nowhere to land. The rendered board and the simulated board come from the same geometry module, so what you see and what the physics uses cannot disagree.

## Determinism and replay

Every simulation is a pure function of its seed. The same seed on the same list produces the same bounces, which is what makes the test proofs possible. On the dev server you can pin the seed sequence with `?seedStart=` and watch the identical run twice.
