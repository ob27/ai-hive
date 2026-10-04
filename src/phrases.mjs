// What an idle agent "says" on its card, chosen by the Hive so the model never has to spend tokens on it.
// Away = the agent will not answer if spoken to (not chatty, or its listening window has passed).
// Listening = it has just finished a turn and is still in the chat (a chatty agent sitting in `hive listen`).

export const AWAY = [
  'Out for smoko', 'Grabbing a coffee', 'Off to the loo', 'Popped out for lunch', 'Stretching its legs',
  'Back in five', 'Gone to refill the water bottle', 'Having a quick walk round the block', 'On a biscuit run',
  'Chatting by the kettle', 'Away from the desk', 'Off to find a charger', 'Watering the office plant',
  'Gone to see a man about a dog', 'Taking five', 'In a meeting that could have been an email',
  'Out getting some fresh air', 'Queuing for the microwave', 'Checking on the printer, again',
  'Having a sit down', 'Nipped out for a sausage roll', 'Gone to look at the whiteboard',
  'Back after this episode', 'Hunting for the good stapler', 'On a very long toilet break',
  'Wandered off to the stationery cupboard', 'Out for a vape and a think', 'Taking the long way to the bathroom',
];

export const LISTENING = [
  'Need anything else?', 'Anything else I can help with?', 'All done. What next?', 'Still here if you need me',
  'Ears open', 'Got a minute if you do', 'Done. Shout if you need anything', 'Just finished. Fire away',
  'Anything else on your list?', 'Standing by', 'Pen down, ears up', 'Right, what else?',
  'Finished that one. Next?', 'Over to you', 'Happy to take another one', 'Go on, hit me',
  'Waiting on your next move', 'Nothing left on my plate. Yours?',
];

/** A stable pick: the same seed (agent + when it stopped) always gives the same line, so the card does not flicker on every refresh. */
export function pick(list, seed) {
  let h = 2166136261;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return list[(h >>> 0) % list.length];
}
