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
    this.realm = 'public'; // 'lan' if behind trusted reverse proxy
    this.rejoinToken = null;
    this.hostSecretAuthed = false; // set when player joins with valid host secret
  }
}
