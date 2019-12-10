import { ClientEvent } from './event.client';
import { ServerEvent } from './event.server';

export const enum GameEventIdentifiers {
  UserMessageEvent,

  CardDropEvent,
  CardResponseEvent,
  CardUseEvent,
  DrawCardEvent,
  ObtainCardEvent,
  MoveCardEvent,

  SkillUseEvent,
  PinDianEvent,
  DamageEvent,
  JudgeEvent,

  GameCreatedEvent,
  GameStartEvent,
  GameOverEvent,
  PlayerEnterEvent,
  PlayerLeaveEvent,
  PlayerDiedEvent,

  AskForPeachEvent,
  AskForNullificationEvent,
  AskForCardResponseEvent,
  AskForCardUseEvent,
  AskForCardDisplayEvent,
  AskForCardDropEvent,
}

export const enum EventMode {
  Client,
  Server,
}

export type BaseGameEvent = {
  triggeredBySkillName?: string;
  message?: string;
}

export type BaseServerEvent = {
  playerId: string;
}

export type EventUtilities = {
  [K in keyof typeof GameEventIdentifiers]: object;
};

export type EventPicker<
  I extends GameEventIdentifiers,
  E extends EventMode
> = BaseGameEvent & (E extends EventMode.Client ? ClientEvent[I] : BaseServerEvent & ServerEvent[I]);

export type ClientEventFinder<I extends GameEventIdentifiers> = BaseGameEvent & ClientEvent[I];
export type ServerEventFinder<I extends GameEventIdentifiers> = BaseGameEvent & BaseServerEvent & ServerEvent[I];

export type AllGameEvent =
  | GameEventIdentifiers.GameCreatedEvent
  | GameEventIdentifiers.GameStartEvent
  | GameEventIdentifiers.GameOverEvent
  | GameEventIdentifiers.PlayerEnterEvent
  | GameEventIdentifiers.PlayerLeaveEvent
  | GameEventIdentifiers.PlayerDiedEvent
  | GameEventIdentifiers.JudgeEvent
  | GameEventIdentifiers.UserMessageEvent
  | GameEventIdentifiers.CardDropEvent
  | GameEventIdentifiers.CardResponseEvent
  | GameEventIdentifiers.CardUseEvent
  | GameEventIdentifiers.SkillUseEvent
  | GameEventIdentifiers.DamageEvent
  | GameEventIdentifiers.PinDianEvent;
