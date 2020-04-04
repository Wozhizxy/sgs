import { CardId } from 'core/cards/libs/card_props';
import {
  CardObtainedReason,
  ClientEventFinder,
  EventPacker,
  GameEventIdentifiers,
  ServerEventFinder,
} from 'core/event/event';
import { INFINITE_TRIGGERING_TIMES } from 'core/game/game_props';
import { PlayerId } from 'core/player/player_props';
import { Room } from 'core/room/room';
import { Precondition } from 'core/shares/libs/precondition/precondition';
import { ActiveSkill, CommonSkill, TriggerableTimes } from 'core/skills/skill';
import { TranslationPack } from 'core/translations/translation_json_tool';

type SelectedCard = {
  card: CardId;
  player: PlayerId;
};

@CommonSkill
@TriggerableTimes(INFINITE_TRIGGERING_TIMES)
export class WuGuFengDengSkill extends ActiveSkill {
  constructor() {
    super('wugufengdeng', 'wugufengdeng_description');
  }

  public canUse() {
    return true;
  }

  public targetFilter(room: Room, targets: PlayerId[]): boolean {
    return targets.length === 0;
  }
  public cardFilter(): boolean {
    return true;
  }
  public isAvailableCard(): boolean {
    return false;
  }
  public isAvailableTarget(): boolean {
    return false;
  }
  public async onUse(room: Room, event: ClientEventFinder<GameEventIdentifiers.CardUseEvent>) {
    const all = room.getAlivePlayersFrom();

    event.translationsMessage = TranslationPack.translationJsonPatcher(
      '{0} used card {1} to {2}',
      TranslationPack.patchPlayerInTranslation(room.getPlayerById(event.fromId)),
      TranslationPack.patchCardInTranslation(event.cardId),
      TranslationPack.wrapArrayParams(...room.getAlivePlayersFrom(event.fromId).map(target => target.Character.Name)),
    ).extract();
    event.toIds = all.map(player => player.Id);

    return true;
  }

  public async beforeEffect(room: Room, event: ServerEventFinder<GameEventIdentifiers.CardEffectEvent>) {
    event.toCardIds = room.getCards(room.AlivePlayers.length, 'top');
    room.addProcessingCards(event.cardId.toString(), ...event.toCardIds);
    EventPacker.addMiddleware(
      {
        tag: event.cardId.toString(),
        data: [],
      },
      event,
    );

    const wugufengdengEvent: ServerEventFinder<GameEventIdentifiers.AskForWuGuFengDengEvent> = {
      cardIds: event.toCardIds!,
      selected: [],
      toId: '',
      userId: event.fromId,
    };

    room.broadcast(GameEventIdentifiers.AskForWuGuFengDengEvent, wugufengdengEvent);

    return true;
  }

  public async onEffect(room: Room, event: ServerEventFinder<GameEventIdentifiers.CardEffectEvent>) {
    const toId = Precondition.exists(event.toIds, 'Unknown targets of wugufengdeng')[0];
    const selectedCards = Precondition.exists(
      EventPacker.getMiddleware<SelectedCard[]>(event.cardId.toString(), event),
      'Unable to get wugufengdeng cards',
    );

    const wugufengdengEvent: ServerEventFinder<GameEventIdentifiers.AskForWuGuFengDengEvent> = {
      cardIds: event.toCardIds!,
      selected: selectedCards,
      toId,
      userId: event.fromId,
    };

    room.broadcast(GameEventIdentifiers.AskForWuGuFengDengEvent, wugufengdengEvent);
    const response = await room.onReceivingAsyncReponseFrom(GameEventIdentifiers.AskForWuGuFengDengEvent, toId);
    selectedCards.push({
      card: response.selectedCard,
      player: toId,
    });
    room.endProcessOnCard(response.selectedCard);

    await room.obtainCards({
      toId,
      reason: CardObtainedReason.ActivePrey,
      cardIds: [response.selectedCard],
    });

    return true;
  }

  public async afterEffect(room: Room, event: ServerEventFinder<GameEventIdentifiers.CardEffectEvent>) {
    const wugufengdengCards = room.getProcessingCards(event.cardId.toString());
    room.endProcessOnTag(event.cardId.toString());

    const droppedCards: CardId[] = [];
    for (const cardId of event.toCardIds!) {
      if (wugufengdengCards.includes(cardId)) {
        droppedCards.push(cardId);
        room.bury(cardId);
      }
    }

    room.broadcast(GameEventIdentifiers.WuGuFengDengFinishEvent, {
      translationsMessage:
        droppedCards.length > 0
          ? TranslationPack.translationJsonPatcher(
              '{0} has been placed into drop stack',
              TranslationPack.patchCardInTranslation(...droppedCards),
            ).extract()
          : undefined,
    });

    return true;
  }
}