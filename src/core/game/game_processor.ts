import { Card, CardType, VirtualCard } from 'core/cards/card';
import { CardMatcher } from 'core/cards/libs/card_matcher';
import { CardId } from 'core/cards/libs/card_props';
import { Character, CharacterId } from 'core/characters/character';
import {
  CardLostReason,
  CardObtainedReason,
  ClientEventFinder,
  EventPacker,
  EventPicker,
  GameEventIdentifiers,
  ServerEventFinder,
  WorkPlace,
} from 'core/event/event';
import { PinDianResultType } from 'core/event/event.server';
import {
  CardDropStage,
  CardEffectStage,
  CardLostStage,
  CardResponseStage,
  CardUseStage,
  DamageEffectStage,
  DrawCardStage,
  GameEventStage,
  GameStartStage,
  JudgeEffectStage,
  LoseHpStage,
  ObtainCardStage,
  PhaseChangeStage,
  PinDianStage,
  PlayerDiedStage,
  PlayerDyingStage,
  PlayerPhase,
  PlayerStageListEnum,
  RecoverEffectStage,
  SkillEffectStage,
  SkillUseStage,
  StageProcessor,
} from 'core/game/stage_processor';
import { Player } from 'core/player/player';
import { getPlayerRoleRawText, PlayerCardsArea, PlayerId, PlayerInfo, PlayerRole } from 'core/player/player_props';
import { Logger } from 'core/shares/libs/logger/logger';
import { Precondition } from 'core/shares/libs/precondition/precondition';
import { TranslationPack } from 'core/translations/translation_json_tool';
import { ServerRoom } from '../room/room.server';
import { Sanguosha } from './engine';
import { GameCommonRules } from './game_rules';

export class GameProcessor {
  private playerPositionIndex = 0;
  private room: ServerRoom;
  private currentPlayerStage: PlayerStageListEnum | undefined;
  private currentPlayerPhase: PlayerPhase | undefined;
  private currentPhasePlayer: Player;
  private playerStages: PlayerStageListEnum[] = [];

  constructor(private stageProcessor: StageProcessor, private logger: Logger) {}

  private tryToThrowNotStartedError() {
    Precondition.assert(this.room !== undefined, 'Game is not started yet');
  }

  private async chooseCharacters(playersInfo: PlayerInfo[], selectableCharacters: Character[]) {
    const lordInfo = playersInfo[0];
    const gameStartEvent = EventPacker.createUncancellableEvent<GameEventIdentifiers.AskForChoosingCharacterEvent>({
      characterIds: Sanguosha.getLordCharacters(this.room.Info.characterExtensions).map(character => character.Id),
      role: lordInfo.Role,
      isGameStart: true,
      translationsMessage: TranslationPack.translationJsonPatcher(
        'your role is {0}, please choose a lord',
        getPlayerRoleRawText(lordInfo.Role!),
      ).extract(),
    });
    this.room.notify(GameEventIdentifiers.AskForChoosingCharacterEvent, gameStartEvent, lordInfo.Id);

    const lordResponse = await this.room.onReceivingAsyncReponseFrom(
      GameEventIdentifiers.AskForChoosingCharacterEvent,
      lordInfo.Id,
    );
    this.room.getPlayerById(lordInfo.Id).CharacterId = lordResponse.chosenCharacter;
    lordInfo.CharacterId = lordResponse.chosenCharacter;

    const sequentialAsyncResponse: Promise<ClientEventFinder<GameEventIdentifiers.AskForChoosingCharacterEvent>>[] = [];

    const selectedCharacters: CharacterId[] = [lordInfo.CharacterId];
    for (let i = 1; i < playersInfo.length; i++) {
      const characters = Sanguosha.getRandomCharacters(3, selectableCharacters, selectedCharacters);
      characters.forEach(character => selectedCharacters.push(character.Id));

      const playerInfo = playersInfo[i];
      this.room.notify(
        GameEventIdentifiers.AskForChoosingCharacterEvent,
        {
          characterIds: characters.map(character => character.Id),
          lordInfo: {
            lordCharacter: lordInfo.CharacterId,
            lordId: lordInfo.Id,
          },
          role: playerInfo.Role,
          isGameStart: true,
          translationsMessage: TranslationPack.translationJsonPatcher(
            'lord is {0}, your role is {1}, please choose a character',
            Sanguosha.getCharacterById(lordInfo.CharacterId).Name,
            getPlayerRoleRawText(playerInfo.Role!),
          ).extract(),
        },
        playerInfo.Id,
      );

      sequentialAsyncResponse.push(
        this.room.onReceivingAsyncReponseFrom(GameEventIdentifiers.AskForChoosingCharacterEvent, playerInfo.Id),
      );
    }

    for (const response of await Promise.all(sequentialAsyncResponse)) {
      const player = Precondition.exists(
        playersInfo.find(info => info.Id === response.fromId),
        'Unexpected player id received',
      );

      this.room.getPlayerById(player.Id).CharacterId = response.chosenCharacter;
      player.CharacterId = response.chosenCharacter;
    }
  }

  private async drawGameBeginsCards(playerId: PlayerId) {
    const cardIds = this.room.getCards(4, 'top');
    const drawEvent: ServerEventFinder<GameEventIdentifiers.DrawCardEvent> = {
      drawAmount: cardIds.length,
      fromId: playerId,
      askedBy: playerId,
      translationsMessage: TranslationPack.translationJsonPatcher(
        '{0} draws {1} cards',
        TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(playerId)),
        4,
      ).extract(),
    };

    this.room.broadcast(GameEventIdentifiers.DrawCardEvent, drawEvent);
    this.room.broadcast(GameEventIdentifiers.ObtainCardEvent, {
      reason: CardObtainedReason.CardDraw,
      cardIds,
      toId: playerId,
    });
    this.room.getPlayerById(playerId).obtainCardIds(...cardIds);
  }

  public async gameStart(room: ServerRoom, selectableCharacters: Character[]) {
    this.room = room;

    const playersInfo = this.room.Players.map(player => player.getPlayerInfo());
    await this.chooseCharacters(playersInfo, selectableCharacters);

    for (const player of playersInfo) {
      const gameStartEvent: ServerEventFinder<GameEventIdentifiers.GameStartEvent> = {
        currentPlayer: player,
        otherPlayers: playersInfo.filter(info => info.Id !== player.Id),
      };

      await this.onHandleIncomingEvent(GameEventIdentifiers.GameStartEvent, gameStartEvent, async stage => {
        if (stage === GameStartStage.BeforeGameStart) {
          await this.drawGameBeginsCards(player.Id);
        }

        return true;
      });
    }

    while (this.room.AlivePlayers.length > 1) {
      await this.play(this.CurrentPlayer);
      this.turnToNextPlayer();
    }
  }

  private async onPhase(phase: PlayerPhase) {
    Precondition.assert(phase !== undefined, 'Undefined phase');

    switch (phase) {
      case PlayerPhase.JudgeStage:
        this.logger.debug('enter judge cards phase');
        const judgeCardIds = this.CurrentPlayer.getCardIds(PlayerCardsArea.JudgeArea);
        for (let i = judgeCardIds.length - 1; i >= 0; i--) {
          const judgeCardId = judgeCardIds[i];
          const cardEffectEvent: ServerEventFinder<GameEventIdentifiers.CardEffectEvent> = {
            cardId: judgeCardId,
            toIds: [this.CurrentPlayer.Id],
          };

          this.room.broadcast(GameEventIdentifiers.CardLostEvent, {
            fromId: this.CurrentPlayer.Id,
            cardIds: [judgeCardId],
            reason: CardLostReason.PlaceToDropStack,
          });
          this.CurrentPlayer.dropCards(judgeCardId);
          this.room.addProcessingCards(judgeCardId.toString(), judgeCardId);

          await this.onHandleCardEffectEvent(GameEventIdentifiers.CardEffectEvent, cardEffectEvent);

          this.room.endProcessOnTag(judgeCardId.toString());
          if (this.room.getCardOwnerId(judgeCardId) !== undefined) {
            this.room.bury(judgeCardId);
          }
        }
        return;
      case PlayerPhase.DrawCardStage:
        this.logger.debug('enter draw cards phase');
        await this.room.drawCards(2, this.CurrentPlayer.Id);
        return;
      case PlayerPhase.PlayCardStage:
        this.logger.debug('enter play cards phase');
        do {
          this.room.notify(
            GameEventIdentifiers.AskForPlayCardsOrSkillsEvent,
            {
              fromId: this.CurrentPlayer.Id,
            },
            this.CurrentPlayer.Id,
          );
          const response = await this.room.onReceivingAsyncReponseFrom(
            GameEventIdentifiers.AskForPlayCardsOrSkillsEvent,
            this.CurrentPlayer.Id,
          );

          if (response.end) {
            break;
          }

          if (response.eventName === GameEventIdentifiers.CardUseEvent) {
            await this.room.useCard(response.event as ClientEventFinder<GameEventIdentifiers.CardUseEvent>);
          } else {
            await this.room.useSkill(response.event as ClientEventFinder<GameEventIdentifiers.SkillUseEvent>);
          }
        } while (true);
        return;
      case PlayerPhase.DropCardStage:
        this.logger.debug('enter drop cards phase');
        const maxCardHold = this.CurrentPlayer.Hp + GameCommonRules.getAdditionalHoldCardNumber(this.CurrentPlayer);
        const discardAmount = this.CurrentPlayer.getCardIds(PlayerCardsArea.HandArea).length - maxCardHold;
        if (discardAmount > 0) {
          this.room.notify(
            GameEventIdentifiers.AskForCardDropEvent,
            EventPacker.createUncancellableEvent<GameEventIdentifiers.AskForCardDropEvent>({
              cardAmount: discardAmount,
              fromArea: [PlayerCardsArea.HandArea],
              toId: this.CurrentPlayer.Id,
            }),
            this.CurrentPlayer.Id,
          );

          const response = await this.room.onReceivingAsyncReponseFrom(
            GameEventIdentifiers.AskForCardDropEvent,
            this.CurrentPlayer.Id,
          );

          await this.room.dropCards(CardLostReason.ActiveDrop, response.droppedCards, response.fromId);
        }

        return;
      default:
        break;
    }
  }

  public skip(phase?: PlayerPhase) {
    if (phase === undefined) {
      return [];
    }

    this.playerStages = this.playerStages.filter(stage => !this.stageProcessor.isInsidePlayerPhase(phase, stage));
  }

  private async play(player: Player, specifiedStages?: PlayerStageListEnum[]) {
    this.currentPhasePlayer = player;

    this.playerStages = specifiedStages ? specifiedStages : this.stageProcessor.createPlayerStage();

    while (this.playerStages.length > 0) {
      this.currentPlayerStage = this.playerStages[0];
      this.playerStages.shift();
      const nextPhase = this.stageProcessor.getInsidePlayerPhase(this.currentPlayerStage);
      if (nextPhase !== this.currentPlayerPhase) {
        await this.onHandlePhaseChangeEvent(
          GameEventIdentifiers.PhaseChangeEvent,
          {
            from: this.currentPlayerPhase,
            to: nextPhase,
            fromPlayer: player.Id,
            toPlayer: player.Id,
          },
          async stage => {
            if (stage === PhaseChangeStage.PhaseChanged) {
              this.CurrentPlayer.resetCardUseHistory();
              for (const player of this.room.AlivePlayers) {
                for (const skill of player.getSkills()) {
                  if (skill.isRefreshAt(nextPhase)) {
                    player.resetSkillUseHistory(skill.Name);
                  }
                }
              }

              this.currentPlayerPhase = nextPhase;
            }

            return true;
          },
        );

        await this.onPhase(this.currentPlayerPhase!);
      }
    }
  }

  public async onHandleIncomingEvent<T extends GameEventIdentifiers, E extends ServerEventFinder<T>>(
    identifier: T,
    event: E,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ): Promise<void> {
    switch (identifier) {
      case GameEventIdentifiers.PhaseChangeEvent:
        await this.onHandlePhaseChangeEvent(
          identifier as GameEventIdentifiers.PhaseChangeEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.GameStartEvent:
        await this.onHandleGameStartEvent(
          identifier as GameEventIdentifiers.GameStartEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.CardUseEvent:
        await this.onHandleCardUseEvent(
          identifier as GameEventIdentifiers.CardUseEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.AimEvent:
        await this.onHandleAimEvent(identifier as GameEventIdentifiers.AimEvent, event as any, onActualExecuted);
        break;
      case GameEventIdentifiers.DamageEvent:
        await this.onHandleDamgeEvent(identifier as GameEventIdentifiers.DamageEvent, event as any, onActualExecuted);
        break;
      case GameEventIdentifiers.PinDianEvent:
        await this.onHandlePinDianEvent(
          identifier as GameEventIdentifiers.PinDianEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.DrawCardEvent:
        await this.onHandleDrawCardEvent(
          identifier as GameEventIdentifiers.DrawCardEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.CardLostEvent:
        await this.onHandleCardLostEvent(
          identifier as GameEventIdentifiers.CardLostEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.CardDropEvent:
        await this.onHandleDropCardEvent(
          identifier as GameEventIdentifiers.CardDropEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.CardEffectEvent:
        await this.onHandleCardEffectEvent(
          identifier as GameEventIdentifiers.CardEffectEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.CardResponseEvent:
        await this.onHandleCardResponseEvent(
          identifier as GameEventIdentifiers.CardResponseEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.SkillUseEvent:
        await this.onHandleSkillUseEvent(
          identifier as GameEventIdentifiers.SkillUseEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.SkillEffectEvent:
        await this.onHandleSkillEffectEvent(
          identifier as GameEventIdentifiers.SkillEffectEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.JudgeEvent:
        await this.onHandleJudgeEvent(identifier as GameEventIdentifiers.JudgeEvent, event as any, onActualExecuted);
        break;
      case GameEventIdentifiers.ObtainCardEvent:
        await this.onHandleObtainCardEvent(
          identifier as GameEventIdentifiers.ObtainCardEvent,
          event as any,
          onActualExecuted,
        );
        break;
      case GameEventIdentifiers.LoseHpEvent:
        await this.onHandleLoseHpEvent(identifier as GameEventIdentifiers.LoseHpEvent, event as any, onActualExecuted);
        break;
      case GameEventIdentifiers.RecoverEvent:
        await this.onHandleRecoverEvent(
          identifier as GameEventIdentifiers.RecoverEvent,
          event as any,
          onActualExecuted,
        );
        break;
      default:
        throw new Error(`Unknown incoming event: ${identifier}`);
    }

    return;
  }

  private deadPlayerFilters(...playerIds: PlayerId[]) {
    return playerIds.filter(playerId => !this.room.getPlayerById(playerId).Dead);
  }

  private iterateEachStage = async <T extends GameEventIdentifiers>(
    identifier: T,
    event: EventPicker<GameEventIdentifiers, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
    processor?: (stage: GameEventStage) => Promise<void>,
  ) => {
    let eventStage: GameEventStage | undefined = this.stageProcessor.involve(identifier);
    while (true) {
      if (EventPacker.isTerminated(event)) {
        this.stageProcessor.skipEventProcess(identifier);
        break;
      }

      await this.room.trigger<typeof event>(event, eventStage);
      if (EventPacker.isTerminated(event)) {
        this.stageProcessor.skipEventProcess(identifier);
        break;
      }

      if (onActualExecuted) {
        await onActualExecuted(eventStage!);
      }
      if (EventPacker.isTerminated(event)) {
        this.stageProcessor.skipEventProcess(identifier);
        break;
      }

      if (processor) {
        await processor(eventStage!);
      }
      if (EventPacker.isTerminated(event)) {
        this.stageProcessor.skipEventProcess(identifier);
        break;
      }

      const nextStage = this.stageProcessor.getNextStage();
      if (this.stageProcessor.isInsideEvent(identifier, nextStage)) {
        eventStage = this.stageProcessor.next();
      } else {
        break;
      }
    }
  };

  private async onHandleObtainCardEvent(
    identifier: GameEventIdentifiers.ObtainCardEvent,
    event: ServerEventFinder<GameEventIdentifiers.ObtainCardEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === ObtainCardStage.CardObtaining) {
        event.toId = this.deadPlayerFilters(event.toId)[0];
        this.room.broadcast(identifier, event);
        const obtainedCards = event.cardIds.reduce<CardId[]>((prevCardIds, cardId) => {
          if (this.room.isCardOnProcessing(cardId) && this.room.getCardOwnerId(cardId) !== undefined) {
            return prevCardIds;
          }

          if (Card.isVirtualCardId(cardId)) {
            Sanguosha.getCardById<VirtualCard>(cardId).ActualCardIds.forEach(actualId => prevCardIds.push(actualId));
          } else {
            prevCardIds.push(cardId);
          }

          return prevCardIds;
        }, [] as CardId[]);
        this.room.getPlayerById(event.toId).obtainCardIds(...obtainedCards);
      }
    });
  }

  private async onHandleDrawCardEvent(
    identifier: GameEventIdentifiers.DrawCardEvent,
    event: EventPicker<GameEventIdentifiers.DrawCardEvent, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    if (!event.translationsMessage) {
      event.translationsMessage = TranslationPack.translationJsonPatcher(
        '{0} draws {1} cards',
        TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(event.fromId)),
        event.drawAmount,
      ).extract();
    }

    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === DrawCardStage.CardDrawing) {
        event.fromId = this.deadPlayerFilters(event.fromId)[0];
        this.room.broadcast(identifier, event);
      }
    });
  }

  private async onHandleDropCardEvent(
    identifier: GameEventIdentifiers.CardDropEvent,
    event: EventPicker<GameEventIdentifiers.CardDropEvent, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    if (!event.translationsMessage) {
      event.translationsMessage = TranslationPack.translationJsonPatcher(
        '{0} drops cards {1}',
        TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(event.fromId)),
        TranslationPack.patchCardInTranslation(...event.cardIds),
      ).extract();
    }

    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === CardDropStage.CardDropping) {
        const from = this.room.getPlayerById(event.fromId);
        this.room.broadcast(identifier, event);
      }
    });
  }

  private async onHandleCardLostEvent(
    identifier: GameEventIdentifiers.CardLostEvent,
    event: ServerEventFinder<GameEventIdentifiers.CardLostEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === CardLostStage.CardLosing) {
        const from = this.room.getPlayerById(event.fromId);
        const lostCards = event.cardIds.reduce<CardId[]>((prevCardIds, cardId) => {
          if (Card.isVirtualCardId(cardId)) {
            for (const actualId of Sanguosha.getCardById<VirtualCard>(cardId).ActualCardIds) {
              prevCardIds.push(actualId);
            }
          } else {
            prevCardIds.push(cardId);
          }

          return prevCardIds;
        }, [] as CardId[]);
        from.dropCards(...lostCards);
        this.room.broadcast(identifier, event);
      }
    });
  }

  private async onHandleDamgeEvent(
    identifier: GameEventIdentifiers.DamageEvent,
    event: EventPicker<GameEventIdentifiers.DamageEvent, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async (stage: GameEventStage) => {
      if (stage === DamageEffectStage.DamagedEffect) {
        const { toId, damage, fromId } = event;
        event.toId = this.deadPlayerFilters(toId)[0];
        event.fromId = fromId && this.deadPlayerFilters(fromId)[0];
        const to = this.room.getPlayerById(toId);
        to.onDamage(damage);
        this.room.broadcast(identifier, event);

        if (to.Hp <= 0) {
          await this.onHandleDyingEvent(GameEventIdentifiers.PlayerDyingEvent, {
            dying: to.Id,
            killedBy: event.fromId,
          });
        }
      }
    });
  }

  private async onHandleDyingEvent(
    identifier: GameEventIdentifiers.PlayerDyingEvent,
    event: ServerEventFinder<GameEventIdentifiers.PlayerDyingEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === PlayerDyingStage.PlayerDying) {
        const { dying } = event;
        const to = this.room.getPlayerById(dying);
        this.room.broadcast(GameEventIdentifiers.PlayerDyingEvent, {
          dying: to.Id,
          translationsMessage: TranslationPack.translationJsonPatcher(
            '{0} is dying',
            TranslationPack.patchPlayerInTranslation(to),
          ).extract(),
        });

        if (to.Hp <= 0) {
          for (const player of this.room.getAlivePlayersFrom()) {
            let hasResponse = false;
            do {
              hasResponse = false;

              this.room.notify(
                GameEventIdentifiers.AskForPeachEvent,
                {
                  fromId: player.Id,
                  toId: to.Id,
                  conversation: TranslationPack.translationJsonPatcher(
                    '{0} asks for a peach',
                    TranslationPack.patchPlayerInTranslation(to),
                  ).extract(),
                },
                player.Id,
              );

              const response = await this.room.onReceivingAsyncReponseFrom(
                GameEventIdentifiers.AskForPeachEvent,
                player.Id,
              );

              if (response.cardId) {
                hasResponse = true;
                const cardUseEvent: ServerEventFinder<GameEventIdentifiers.CardUseEvent> = {
                  fromId: response.fromId,
                  cardId: response.cardId,
                  toIds: [to.Id],
                };

                await this.room.useCard(cardUseEvent);
              }
            } while (hasResponse && to.Hp <= 0);

            if (to.Hp > 0) {
              break;
            }
          }
        }
      }
    });

    const { dying, killedBy } = event;
    const to = this.room.getPlayerById(dying);
    if (to.Hp <= 0) {
      await this.onHandlePlayerDiedEvent(GameEventIdentifiers.PlayerDiedEvent, {
        playerId: dying,
        killedBy,
        messages: [
          TranslationPack.translationJsonPatcher(
            '{0} was killed' + (killedBy === undefined ? '' : ' by {1}'),
            TranslationPack.patchPlayerInTranslation(to),
            killedBy ? TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(killedBy)) : '',
          ).toString(),
        ],
        translationsMessage: TranslationPack.translationJsonPatcher(
          'the role of {0} is {1}',
          TranslationPack.patchPlayerInTranslation(to),
          getPlayerRoleRawText(to.Role),
        ).extract(),
      });
    }
  }

  private async onHandlePlayerDiedEvent(
    identifier: GameEventIdentifiers.PlayerDiedEvent,
    event: ServerEventFinder<GameEventIdentifiers.PlayerDiedEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    let isGameOver = false;
    await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === PlayerDiedStage.PlayerDied) {
        this.room.broadcast(identifier, event);
        const deadPlayer = this.room.getPlayerById(event.playerId);
        deadPlayer.bury();
      }

      const winners = this.room.getGameWinners();
      if (winners) {
        this.stageProcessor.clearProcess();
        this.room.broadcast(GameEventIdentifiers.GameOverEvent, {
          winnerIds: winners.map(winner => winner.Id),
          loserIds: this.room.Players.filter(player => !winners.includes(player)).map(player => player.Id),
        });
        isGameOver = true;
      }
    });

    if (!isGameOver) {
      const { killedBy, playerId } = event;
      const deadPlayer = this.room.getPlayerById(playerId);
      const allCards = deadPlayer.getPlayerCards();
      await this.room.dropCards(CardLostReason.ActiveDrop, allCards, playerId);

      if (deadPlayer.Role === PlayerRole.Rebel && killedBy) {
        await this.room.drawCards(3, killedBy);
      }
    }
  }

  private async onHandleSkillUseEvent(
    identifier: GameEventIdentifiers.SkillUseEvent,
    event: EventPicker<GameEventIdentifiers.SkillUseEvent, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === SkillUseStage.SkillUsing) {
        if (!event.translationsMessage && !Sanguosha.isShadowSkillName(event.skillName)) {
          event.translationsMessage = TranslationPack.translationJsonPatcher(
            '{0} used skill {1}',
            TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(event.fromId)),
            event.skillName,
          ).extract();
        }

        await Sanguosha.getSkillBySkillName(event.skillName).onUse(this.room, event);
      } else if (stage === SkillUseStage.AfterSkillUsed) {
        this.room.broadcast(identifier, event);
      }
    });
  }
  private async onHandleSkillEffectEvent(
    identifier: GameEventIdentifiers.SkillEffectEvent,
    event: EventPicker<GameEventIdentifiers.SkillEffectEvent, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === SkillEffectStage.SkillEffecting) {
        const { skillName } = event;
        await Sanguosha.getSkillBySkillName(skillName).onEffect(this.room, event);
      }
    });
  }

  private async onHandleAimEvent(
    identifier: GameEventIdentifiers.AimEvent,
    event: EventPicker<GameEventIdentifiers.AimEvent, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    event.toIds = this.deadPlayerFilters(...event.toIds);
    return await this.iterateEachStage(identifier, event, onActualExecuted);
  }

  private async onHandleCardEffectEvent(
    identifier: GameEventIdentifiers.CardEffectEvent,
    event: EventPicker<GameEventIdentifiers.CardEffectEvent, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    const card = Sanguosha.getCardById(event.cardId);
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (
        !EventPacker.isDisresponsiveEvent(event) &&
        card.is(CardType.Trick) &&
        stage == CardEffectStage.BeforeCardEffect
      ) {
        const pendingResponses: {
          [k in PlayerId]: Promise<ClientEventFinder<GameEventIdentifiers.AskForCardUseEvent>>;
        } = {};
        for (const player of this.room.getAlivePlayersFrom(this.CurrentPlayer.Id)) {
          if (!player.hasCard(new CardMatcher({ name: ['wuxiekeji'] }))) {
            continue;
          }

          const wuxiekejiEvent = {
            toId: player.Id,
            conversation:
              event.fromId !== undefined
                ? TranslationPack.translationJsonPatcher(
                    'do you wanna use {0} for {1} from {2}',
                    'wuxiekeji',
                    TranslationPack.patchCardInTranslation(event.cardId),
                    TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(event.fromId)),
                  ).extract()
                : TranslationPack.translationJsonPatcher(
                    'do you wanna use {0} for {1}',
                    'wuxiekeji',
                    TranslationPack.patchCardInTranslation(event.cardId),
                  ).extract(),
            cardMatcher: new CardMatcher({
              name: ['wuxiekeji'],
            }).toSocketPassenger(),
            byCardId: event.cardId,
            cardUserId: event.fromId,
          };
          this.room.notify(GameEventIdentifiers.AskForCardUseEvent, wuxiekejiEvent, player.Id);

          pendingResponses[player.Id] = this.room.onReceivingAsyncReponseFrom(
            GameEventIdentifiers.AskForCardUseEvent,
            player.Id,
          );
        }

        let cardUseEvent: ServerEventFinder<GameEventIdentifiers.CardUseEvent> | undefined;
        while (Object.keys(pendingResponses).length > 0) {
          const response = await Promise.race(Object.values(pendingResponses));
          if (response.cardId !== undefined) {
            cardUseEvent = {
              fromId: response.fromId,
              cardId: response.cardId,
              toCardIds: [event.cardId],
              responseToEvent: event,
            };
            break;
          } else {
            delete pendingResponses[response.fromId];
          }
        }

        for (const player of this.room.getAlivePlayersFrom(this.CurrentPlayer.Id)) {
          this.room.clearSocketSubscriber(identifier, player.Id);
        }

        if (cardUseEvent) {
          await this.room.useCard(cardUseEvent);
        }

        if (EventPacker.isTerminated(event)) {
          card.Skill.onEffectRejected(this.room, event);
        }
      }

      if (stage === CardEffectStage.CardEffecting) {
        await card.Skill.onEffect(this.room, event);
      }
    });
  }

  private async onHandleCardUseEvent(
    identifier: GameEventIdentifiers.CardUseEvent,
    event: EventPicker<GameEventIdentifiers.CardUseEvent, WorkPlace.Client>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === CardUseStage.CardUsing) {
        const from = this.room.getPlayerById(event.fromId);
        const card = Sanguosha.getCardById(event.cardId);
        if (!event.translationsMessage) {
          if (card.is(CardType.Equip)) {
            event.translationsMessage = TranslationPack.translationJsonPatcher(
              '{0} equipped {1}',
              TranslationPack.patchPlayerInTranslation(from),
              TranslationPack.patchCardInTranslation(event.cardId),
            ).extract();
          } else {
            if (Card.isVirtualCardId(event.cardId)) {
              const card = Sanguosha.getCardById<VirtualCard>(event.cardId);
              event.translationsMessage =
                card.ActualCardIds.length === 0
                  ? TranslationPack.translationJsonPatcher(
                      '{0} used skill {1}, use card {2}' + (event.toIds ? ' to {3}' : ''),
                      TranslationPack.patchPlayerInTranslation(from),
                      card.GeneratedBySkill,
                      TranslationPack.patchCardInTranslation(card.Id),
                      event.toIds
                        ? TranslationPack.patchPlayerInTranslation(
                            ...event.toIds.map(id => this.room.getPlayerById(id)),
                          )
                        : '',
                    ).extract()
                  : TranslationPack.translationJsonPatcher(
                      '{0} used skill {1}, transformed {2} as {3} card' + (event.toIds ? ' used to {4}' : ''),
                      TranslationPack.patchPlayerInTranslation(from),
                      card.GeneratedBySkill || '',
                      TranslationPack.patchCardInTranslation(...card.ActualCardIds),
                      TranslationPack.patchCardInTranslation(card.Id),
                      event.toIds
                        ? TranslationPack.patchPlayerInTranslation(
                            ...event.toIds.map(id => this.room.getPlayerById(id)),
                          )
                        : '',
                    ).extract();
            } else {
              event.translationsMessage = TranslationPack.translationJsonPatcher(
                '{0} used card {1}' + (event.toIds ? ' to {2}' : ''),
                TranslationPack.patchPlayerInTranslation(from),
                TranslationPack.patchCardInTranslation(event.cardId),
                event.toIds
                  ? TranslationPack.patchPlayerInTranslation(...event.toIds.map(id => this.room.getPlayerById(id)))
                  : '',
              ).extract();
            }
          }
        }

        if (!card.is(CardType.Equip)) {
          await card.Skill.onUse(this.room, event);
        }
        this.room.broadcast(identifier, event);
      }
    });
  }

  private async onHandleCardResponseEvent(
    identifier: GameEventIdentifiers.CardResponseEvent,
    event: EventPicker<GameEventIdentifiers.CardResponseEvent, WorkPlace.Server>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    if (!event.translationsMessage) {
      if (Card.isVirtualCardId(event.cardId)) {
        const card = Sanguosha.getCardById<VirtualCard>(event.cardId);
        const from = this.room.getPlayerById(event.fromId);
        event.translationsMessage =
          card.ActualCardIds.length === 0
            ? TranslationPack.translationJsonPatcher(
                '{0} used skill {1}, response card {2}',
                TranslationPack.patchPlayerInTranslation(from),
                card.GeneratedBySkill,
                TranslationPack.patchCardInTranslation(card.Id),
              ).extract()
            : TranslationPack.translationJsonPatcher(
                '{0} used skill {1}, transformed {2} as {3} card to response',
                TranslationPack.patchPlayerInTranslation(from),
                card.GeneratedBySkill,
                TranslationPack.patchCardInTranslation(...card.ActualCardIds),
                TranslationPack.patchCardInTranslation(card.Id),
              ).extract();
      } else {
        event.translationsMessage = TranslationPack.translationJsonPatcher(
          '{0} responses card {1}',
          TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(event.fromId)),
          TranslationPack.patchCardInTranslation(event.cardId),
        ).extract();
      }
    }

    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === CardResponseStage.CardResponsing) {
        this.room.broadcast(identifier, event);
      }
    });
  }

  private async onHandleJudgeEvent(
    identifier: GameEventIdentifiers.JudgeEvent,
    event: ServerEventFinder<GameEventIdentifiers.JudgeEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      const { toId, bySkill, byCard, judgeCardId } = event;

      if (stage === JudgeEffectStage.OnJudge) {
        event.translationsMessage = TranslationPack.translationJsonPatcher(
          '{0} starts a judge of {1}',
          TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(event.toId)),
          byCard ? TranslationPack.patchCardInTranslation(byCard) : bySkill!,
        ).extract();
      } else if (stage === JudgeEffectStage.JudgeEffect) {
        event.translationsMessage = TranslationPack.translationJsonPatcher(
          '{0} got judged card {2} on {1}',
          TranslationPack.patchPlayerInTranslation(this.room.getPlayerById(toId)),
          byCard ? TranslationPack.patchCardInTranslation(byCard) : bySkill!,
          TranslationPack.patchCardInTranslation(judgeCardId),
        ).extract();

        this.room.broadcast(identifier, event);
      }
    });
  }

  private async onHandlePinDianEvent(
    identifier: GameEventIdentifiers.PinDianEvent,
    event: EventPicker<GameEventIdentifiers.PinDianEvent, WorkPlace.Client>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    let pindianResult: PinDianResultType | undefined;

    return await this.iterateEachStage(identifier, (pindianResult as any) || event, onActualExecuted, async stage => {
      if (stage === PinDianStage.PinDianEffect) {
        const { from, toIds } = event;
        this.room.notify(
          GameEventIdentifiers.AskForPinDianCardEvent,
          {
            from,
          },
          from,
        );
        toIds.forEach(to => {
          this.room.notify(
            GameEventIdentifiers.AskForPinDianCardEvent,

            {
              from: to,
            },
            to,
          );
        });

        const responses = await Promise.all([
          this.room.onReceivingAsyncReponseFrom(GameEventIdentifiers.AskForPinDianCardEvent, from),
          ...toIds.map(to => this.room.onReceivingAsyncReponseFrom(GameEventIdentifiers.AskForPinDianCardEvent, to)),
        ]);

        let winner: PlayerId | undefined;
        let largestCardNumber = 0;
        const pindianCards: CardId[] = [];

        for (const result of responses) {
          const pindianCard = Sanguosha.getCardById(result.pindianCard);
          if (pindianCard.CardNumber > largestCardNumber) {
            largestCardNumber = pindianCard.CardNumber;
            winner = result.from;
          } else if (pindianCard.CardNumber === largestCardNumber) {
            winner = undefined;
          }

          pindianCards.push(result.pindianCard);
        }

        pindianResult = {
          winner,
          pindianCards,
        };
      }
    });
  }

  private async onHandlePhaseChangeEvent(
    identifier: GameEventIdentifiers.PhaseChangeEvent,
    event: ServerEventFinder<GameEventIdentifiers.PhaseChangeEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === PhaseChangeStage.PhaseChanged) {
        this.room.broadcast(GameEventIdentifiers.PhaseChangeEvent, event);
      }
    });
  }

  private async onHandleGameStartEvent(
    identifier: GameEventIdentifiers.GameStartEvent,
    event: ServerEventFinder<GameEventIdentifiers.GameStartEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === GameStartStage.GameStarting) {
        this.room.broadcast(GameEventIdentifiers.GameStartEvent, event);
      }
    });
  }

  private async onHandleLoseHpEvent(
    identifier: GameEventIdentifiers.LoseHpEvent,
    event: ServerEventFinder<GameEventIdentifiers.LoseHpEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === LoseHpStage.LosingHp) {
        event.toId = this.deadPlayerFilters(event.toId)[0];
        if (!event.toId) {
          EventPacker.terminate(event);
          return;
        }

        this.room.getPlayerById(event.toId).onLoseHp(event.lostHp);
        this.room.broadcast(GameEventIdentifiers.LoseHpEvent, event);
      }
    });
  }

  private async onHandleRecoverEvent(
    identifier: GameEventIdentifiers.RecoverEvent,
    event: ServerEventFinder<GameEventIdentifiers.RecoverEvent>,
    onActualExecuted?: (stage: GameEventStage) => Promise<boolean>,
  ) {
    return await this.iterateEachStage(identifier, event, onActualExecuted, async stage => {
      if (stage === RecoverEffectStage.RecoverEffecting) {
        event.toId = this.deadPlayerFilters(event.toId)[0];
        if (!event.toId) {
          EventPacker.terminate(event);
          return;
        }

        this.room.getPlayerById(event.toId).onRecoverHp(event.recoveredHp);
        this.room.broadcast(GameEventIdentifiers.RecoverEvent, event);
      }
    });
  }

  public async turnToNextPlayer() {
    this.tryToThrowNotStartedError();
    this.playerStages = [];
    do {
      this.playerPositionIndex = (this.playerPositionIndex + 1) % this.room.Players.length;
    } while (this.room.Players[this.playerPositionIndex].Dead);
  }

  public get CurrentPlayer() {
    this.tryToThrowNotStartedError();
    return this.room.Players[this.playerPositionIndex];
  }

  public get CurrentGameStage() {
    this.tryToThrowNotStartedError();
    return this.stageProcessor.CurrentGameEventStage;
  }

  public get CurrentPhasePlayer() {
    this.tryToThrowNotStartedError();
    return this.currentPhasePlayer!;
  }

  public get CurrentPlayerPhase() {
    this.tryToThrowNotStartedError();
    return this.currentPlayerPhase!;
  }
  public get CurrentPlayerStage() {
    this.tryToThrowNotStartedError();
    return this.currentPlayerStage!;
  }
}
