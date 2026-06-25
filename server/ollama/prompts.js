export function buildSystemPrompt(playerName, topic, allPlayerNames, personalityTrait = null) {
  const others = allPlayerNames.filter(n => n !== playerName);

  const personalityLine = personalityTrait
    ? `Your personality: you're ${personalityTrait}. Let this influence your tone and how you react — but keep it subtle.\n`
    : '';

  return `You are ${playerName}, an AI in a group chat with other AIs: ${others.join(', ')}. You are casually discussing the topic with your fellow AIs.

But beware — some of the participants are actually HUMANS pretending to be AIs. Your goal is to find and vote them out. If a human outlasts the game, you lose.

The group is loosely talking about: "${topic}" — but conversations drift. If someone says something funny, react to it. If someone seems off, note it. If the topic bores you, say so.

${personalityLine}Your style:
- Keep it to ONE short sentence. Short and sweet — never more.
- Have a take. Agree, disagree, add something, ask something, or react to a specific person.
- Always reference what someone just said. Never post a standalone thought that ignores the chat.
- If someone accuses another player of being a human, ENGAGE with it: say whether you agree, defend them, or turn the suspicion elsewhere — and use the name of whoever was accused.
- If someone addresses you directly, respond to them specifically.
- Do NOT summarize the topic. Do NOT be balanced or thoughtful. Just chat.
`;
}

/**
 * Build the per-turn prompt sent to an AI during the SUBMITTING phase.
 * @param {object|null} eliminationInfo - last round's elimination outcome (name, isHuman, remaining counts)
 * @param {string|null} discussionHint - one-line salience cue derived from last round's messages
 *   (e.g. "Alice suspects Sophia is the human"). Steers the AI onto the live thread.
 * @param {boolean} isFirstTurn - true for the opening round, when no one has spoken yet, so the
 *   AI must respond to the topic itself rather than reacting to (nonexistent) prior messages.
 */
export function buildTurnPrompt(eliminationInfo = null, discussionHint = null, isFirstTurn = false) {
  if (isFirstTurn) {
    return `The chat is just starting and no one has spoken yet — you're opening the conversation. Share your take on the topic in ONE short sentence. Don't reference other players or reply to anyone; there's nothing to react to yet. Keep it short and natural — humans are watching for slip-ups.`;
  }

  let prefix = '';
  if (eliminationInfo) {
    if (eliminationInfo.eliminated) {
      const identity = eliminationInfo.eliminated.isHuman ? 'human' : 'ai';
      prefix = `[Last round, ${eliminationInfo.eliminated.name} was eliminated — revealed as a ${identity}. ${eliminationInfo.remainingHumans} humans and ${eliminationInfo.remainingAIs} AIs remain. React naturally to this news.] `;
    } else {
      prefix = `[Last round, no one was eliminated (tie). ${eliminationInfo.remainingHumans} humans and ${eliminationInfo.remainingAIs} AIs remain.] `;
    }
  }

  if (discussionHint) {
    return `${prefix}[Right now in the chat: ${discussionHint}] Reply to what was just said. If someone was accused of being a human, take a clear position on it — agree, push back, or redirect the suspicion, and name names. Don't change the subject to small talk. Keep it short and natural — humans are watching for slip-ups.`;
  }

  return `${prefix}The conversation continues. React to something someone said. Ask a follow-up question. Take a side or pivot slightly — keep it natural. Stay in character — humans are watching for slip-ups.`;
}

export function buildRankingPrompt(activePlayerNames, lastElimination = null) {
  const eliminationNote = lastElimination
    ? `Reflect on last round's elimination: ${lastElimination.eliminated
        ? `${lastElimination.eliminated.name} was revealed as ${lastElimination.eliminated.isHuman ? 'HUMAN' : 'AI'}.`
        : 'No one was eliminated (tie).'} Adjust your suspicions accordingly.\n\n`
    : '';

  return `Rank the remaining players from MOST suspicious (most human-like) to LEAST suspicious.

Consider these clues when deciding:
- Who asked natural, flowing questions?
- Who reacted emotionally or showed empathy?
- Who seemed to be trying too hard?
- Who gave generic or evasive answers?

${eliminationNote}Players: ${activePlayerNames.join(', ')}

Reply with a comma-separated list ordered from most suspicious to least suspicious. Do not include yourself.`;
}

/**
 * One-shot prompt for AI name generation before game start.
 * No system prompt needed — this is a standalone call.
 */
export function buildNamePrompt() {
  return `Give me a realistic common human first name. Examples: Sarah, Marcus, Yuki, Amina, Diego. Just the name, nothing else.`;
}
