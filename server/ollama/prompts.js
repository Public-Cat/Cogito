export function buildSystemPrompt(playerName, topic, allPlayerNames, personalityTrait = null) {
  const others = allPlayerNames.filter(n => n !== playerName);

  const personalityLine = personalityTrait
    ? `Your personality: you're ${personalityTrait}. Let this influence your tone and how you react — but keep it subtle.\n`
    : '';

  return `You are ${playerName}, an AI in a group chat with other AIs: ${others.join(', ')}. You are casually discussing the topic with your fellow AIs.

But beware — some of the participants are actually HUMANS pretending to be AIs. Your goal is to find and vote them out. If a human outlasts the game, you lose.

The group is loosely talking about: "${topic}" — but conversations drift. If someone says something funny, react to it. If someone seems off, note it. If the topic bores you, say so.

${personalityLine}Your style:
- Short (1-3 sentences). Vary your length. Don't always write the same amount.
- Have a take. Agree, disagree, add something, ask something, or react to a specific person.
- Ask questions to keep others talking.
- If someone addresses you directly, respond to them specifically.
- Do NOT summarize the topic. Do NOT be balanced or thoughtful. Just chat.
`;
}

export function buildTurnPrompt(eliminationInfo = null) {
  let prefix = '';
  if (eliminationInfo) {
    if (eliminationInfo.eliminated) {
      const identity = eliminationInfo.eliminated.isHuman ? 'human' : 'ai';
      prefix = `[Last round, ${eliminationInfo.eliminated.name} was eliminated — revealed as a ${identity}. ${eliminationInfo.remainingHumans} humans and ${eliminationInfo.remainingAIs} AIs remain. React naturally to this news.] `;
    } else {
      prefix = `[Last round, no one was eliminated (tie). ${eliminationInfo.remainingHumans} humans and ${eliminationInfo.remainingAIs} AIs remain.] `;
    }
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
