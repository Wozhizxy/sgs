import { EventMode, EventPicker, GameEventIdentifiers } from 'core/event/event';
import { Room } from 'core/game/room';
import { Socket, SocketMessage } from 'core/network/socket';
import { PlayerId, PlayerInfo } from 'core/player/player_props';
import { createHash } from 'crypto';
import * as ServerWebSocket from 'ws';

type WebSocket = ServerWebSocket & {
  id: string;
};

export class ServerSocket extends Socket<EventMode.Server> {
  private socket: ServerWebSocket.Server;
  private room: Room;
  private clients: WebSocket[];
  private hash = createHash('sha256');

  constructor() {
    super(EventMode.Server);

    this.socket = new ServerWebSocket.Server({ noServer: true });
    this.socket.on('connection', (ws: WebSocket, req) => {
      this.hash.update(this.clients.length.toString());
      ws.id = this.hash.digest('latin1');

      ws.on('message', data => {
        const { type, content } = JSON.parse(data as string) as SocketMessage<
          GameEventIdentifiers,
          EventMode.Client
        >;

        if (this.room !== undefined) {
          if (type === GameEventIdentifiers.PlayerEnterEvent) {
            const { playerLanguage, playerName } = content as EventPicker<
              GameEventIdentifiers.PlayerEnterEvent,
              EventMode.Client
            >;

            const playerInfo: PlayerInfo = {
              Id: ws.id,
              Position: this.clients.length - 1,
              Name: playerName,
              CharacterId: undefined,
              Role: undefined,
            };

            playerInfo.Id = ws.id;
            playerInfo.Position = this.clients.length - 1;

            this.room && this.room.createPlayer(playerInfo, playerLanguage);
          }

          this.room.on<typeof type>(type, content);
        }
      });
    });
  }

  public emit(room: Room) {
    if (!this.room) {
      this.room = room;
    }
  }

  public sendEvent(
    type: GameEventIdentifiers,
    content: EventPicker<typeof type, EventMode.Client>,
    to: PlayerId,
  ) {
    const clientSocket = this.clients.find(client => client.id === to);
    if (!clientSocket) {
      throw new Error(
        `Unable to find player: ${to} in connected socket clients`,
      );
    }

    clientSocket.send(JSON.stringify({ type, content }));
  }

  broadcast(
    type: GameEventIdentifiers,
    content: EventPicker<typeof type, EventMode.Client>,
  ) {
    this.socket.clients.forEach(client => {
      client.send(JSON.stringify({ type, content }));
    });
  }
}
