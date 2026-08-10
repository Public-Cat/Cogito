export class Player {
  constructor(id, isHuman, socketId) {
    this.id = id;
    this.isHuman = isHuman;
    this.socketId = socketId;
    this.name = '';
    this.isDisconnected = false;
    this.isEliminated = false;
    this.isHost = false;
    this.model = null;
    this.messageHistory = null;
    this.currentVote = null;
    // 'lan' players are eligible to be host (set from socket.data.realm).
    // Defaults to 'public' fail-safe; AIs have no socket so stay 'public'.
    this.realm = 'public';
    // Secret token proving ownership of this player slot across reconnects.
    // Generated for humans on creation; never sent to anyone but the owner.
    this.rejoinToken = null;
  }
}
