export class Player {
  constructor(id, isHuman, socketId) {
    this.id = id;
    this.isHuman = isHuman;
    this.socketId = socketId;
    this.name = '';
    this.isActive = true;
    this.isDisconnected = false;
    this.isEliminated = false;
    this.isHost = false;
    this.model = null;
    this.messageHistory = null;
    this.lastMessageIndex = 0;
  }
}
