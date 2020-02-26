import { Character, CharacterId } from 'core/characters/character';
import {
  ClientEventFinder,
  GameEventIdentifiers,
  ServerEventFinder,
} from 'core/event/event';
import { Sanguosha } from 'core/game/engine';
import { Translation } from 'core/translations/translation_json_tool';
import * as React from 'react';
import { CharacterCard } from './character/character';
import styles from './room.module.css';
import { RoomPresenter, RoomStore } from './room.presenter';

export class GameClientProcessor {
  constructor(
    private presenter: RoomPresenter,
    private store: RoomStore,
    private translator: Translation,
  ) {}

  private tryToThrowNotReadyException(e: GameEventIdentifiers) {
    if (!this.store.room && e !== GameEventIdentifiers.PlayerEnterEvent) {
      throw new Error(
        'Game client process does not work when client room is not initialized',
      );
    }
  }

  async onHandleIncomingEvent<T extends GameEventIdentifiers>(
    e: T,
    content: ServerEventFinder<T>,
  ) {
    this.tryToThrowNotReadyException(e);

    switch (e) {
      case GameEventIdentifiers.GameReadyEvent:
        this.onHandleGameReadyEvent(e as any, content);
        break;
      case GameEventIdentifiers.GameStartEvent:
        await this.onHandleGameStartEvent(e as any, content);
        break;
      case GameEventIdentifiers.PlayerEnterEvent:
        this.onHandlePlayerEnterEvent(e as any, content);
        break;
      case GameEventIdentifiers.PlayerLeaveEvent:
        this.onHandlePlayerLeaveEvent(e as any, content);
        break;
      case GameEventIdentifiers.AskForChooseCharacterEvent:
        this.onHandleChooseCharacterEvent(e as any, content);
        break;
      default:
        throw new Error(`Unhandled Game event: ${e}`);
    }
  }

  private onHandleGameStartEvent<T extends GameEventIdentifiers.GameStartEvent>(
    type: T,
    content: ServerEventFinder<T>,
  ) {}

  private async onHandleGameReadyEvent<
    T extends GameEventIdentifiers.GameReadyEvent
  >(type: T, content: ServerEventFinder<T>) {
    content.playersInfo.forEach(playerInfo => {
      const player = this.store.room.getPlayerById(playerInfo.Id);
      player.Position = playerInfo.Position;
    });
    await this.store.room.gameStart(content.gameStartInfo);
  }

  private onHandlePlayerEnterEvent<
    T extends GameEventIdentifiers.PlayerEnterEvent
  >(type: T, content: ServerEventFinder<T>) {
    if (this.store.clientRoomInfo === undefined) {
      throw new Error('Uninitialized Client room info');
    }

    if (content.joiningPlayerName === this.store.clientRoomInfo.playerName) {
      this.presenter.createClientRoom(
        this.store.clientRoomInfo.roomId,
        this.store.clientRoomInfo.socket,
        content.gameInfo,
        content.playersInfo,
      );
      this.presenter.setupClientPlayerId(content.joiningPlayerId);
    } else {
      const playerInfo = content.playersInfo.find(
        playerInfo => playerInfo.Name === content.joiningPlayerName,
      );

      if (!playerInfo) {
        throw new Error(`Unknown player ${content.joiningPlayerName}`);
      }

      this.presenter.playerEnter(playerInfo);
    }
  }

  private onHandlePlayerLeaveEvent<
    T extends GameEventIdentifiers.PlayerLeaveEvent
  >(type: T, content: ServerEventFinder<T>) {
    this.presenter.playerLeave(content.playerId);
  }

  private onHandleChooseCharacterEvent<
    T extends GameEventIdentifiers.AskForChooseCharacterEvent
  >(type: T, content: ServerEventFinder<T>) {
    const onClick = (character: Character) => {
      this.presenter.closeDialog();

      const response: ClientEventFinder<T> = {
        isGameStart: content.isGameStart,
        chosenCharacter: character.Id,
        fromId: this.store.clientPlayerId,
      };
      this.store.room.broadcast(type, response);
    };

    this.presenter.createDialog(
      this.translator.tr('please choose a character'),
      this.getCharacterSelector(content.characterIds, onClick),
    );
  }

  private getCharacterSelector(
    characterIds: CharacterId[],
    onClick?: (character: Character) => void,
  ) {
    const characters = characterIds.map(characterId => {
      const character = Sanguosha.getCharacterById(characterId);

      return (
        <CharacterCard
          translator={this.translator}
          character={character}
          key={characterId}
          onClick={onClick}
          className={styles.characterSelectorItem}
        />
      );
    });

    return <div className={styles.characterSelector}>{characters}</div>;
  }
}