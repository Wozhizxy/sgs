import { Card, VirtualCard } from 'core/cards/card';
import { CardId, CardSuit } from 'core/cards/libs/card_props';
import { CardMoveArea, CardMoveReason, EventPacker, GameEventIdentifiers, ServerEventFinder } from 'core/event/event';
import { Sanguosha } from 'core/game/engine';
import { DamageType } from 'core/game/game_props';
import { AllStage, DamageEffectStage } from 'core/game/stage_processor';
import { Player } from 'core/player/player';
import { PlayerCardsArea, PlayerId } from 'core/player/player_props';
import { Room } from 'core/room/room';
import { CommonSkill, TriggerSkill } from 'core/skills/skill';
import { TranslationPack } from 'core/translations/translation_json_tool';

@CommonSkill({ name: 'tianxiang', description: 'tianxiang_description' })
export class TianXiang extends TriggerSkill {
  isTriggerable(event: ServerEventFinder<GameEventIdentifiers.DamageEvent>, stage?: AllStage) {
    return stage === DamageEffectStage.DamagedEffect;
  }

  canUse(room: Room, owner: Player, content: ServerEventFinder<GameEventIdentifiers.DamageEvent>) {
    return owner.Id === content.toId && owner.getCardIds(PlayerCardsArea.HandArea).length > 0;
  }

  isAvailableTarget(owner: PlayerId, room: Room, target: PlayerId) {
    return owner !== target;
  }

  targetFilter(room: Room, targets: PlayerId[]): boolean {
    return targets.length === 1;
  }

  isAvailableCard(owner: PlayerId, room: Room, cardId: CardId) {
    return (
      Sanguosha.getCardById(cardId).Suit === CardSuit.Heart &&
      room.getPlayerById(owner).cardFrom(cardId) === PlayerCardsArea.HandArea
    );
  }

  cardFilter(room: Room, cards: CardId[]): boolean {
    return cards.length === 1;
  }

  async onTrigger() {
    return true;
  }

  async onEffect(room: Room, skillUseEvent: ServerEventFinder<GameEventIdentifiers.SkillEffectEvent>) {
    const { triggeredOnEvent, fromId, cardIds, toIds } = skillUseEvent;
    await room.dropCards(CardMoveReason.SelfDrop, cardIds!, fromId, fromId, this.Name);
    const hpChangeEvent = triggeredOnEvent as ServerEventFinder<GameEventIdentifiers.HpChangeEvent>;
    EventPacker.terminate(hpChangeEvent);

    const chooseOptions: ServerEventFinder<GameEventIdentifiers.AskForChoosingOptionsEvent> = {
      options: ['option-one', 'option-two'],
      toId: fromId,
      conversation: TranslationPack.translationJsonPatcher(
        'please choose tianxiang options:{0}',
        hpChangeEvent.amount,
      ).extract(),
    };
    room.notify(
      GameEventIdentifiers.AskForChoosingOptionsEvent,
      EventPacker.createUncancellableEvent<GameEventIdentifiers.AskForChoosingOptionsEvent>(chooseOptions),
      fromId,
    );
    const response = await room.onReceivingAsyncReponseFrom(GameEventIdentifiers.AskForChoosingOptionsEvent, fromId);
    if (response.selectedOption === 'option-one') {
      await room.damage({
        toId: toIds![0],
        damage: 1,
        damageType: DamageType.Normal,
        triggeredBySkills: [this.Name],
      });
      const to = room.getPlayerById(toIds![0]);
      await room.drawCards(to.MaxHp - to.Hp, to.Id, undefined, undefined, this.Name);
    } else {
      await room.loseHp(toIds![0], 1);
      let droppedCardIds = cardIds!;
      if (Card.isVirtualCardId(droppedCardIds[0])) {
        droppedCardIds = Sanguosha.getCardById<VirtualCard>(droppedCardIds[0]).ActualCardIds;
      }
      for (const cardId of droppedCardIds) {
        if (room.isCardInDropStack(cardId)) {
          await room.moveCards({
            movingCards: [{ card: cardId, fromArea: CardMoveArea.DropStack }],
            toId: toIds![0],
            toArea: CardMoveArea.HandArea,
            moveReason: CardMoveReason.PassiveMove,
            proposer: fromId,
            movedByReason: this.Name,
          });
        }
      }
    }
    return true;
  }
}
