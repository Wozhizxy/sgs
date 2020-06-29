import { PlayerRole } from 'core/player/player_props';
import { ImageProps } from 'props/image_props';

export interface ImageLoader {
  getCardImage(name: string): Promise<ImageProps>;
  getCharacterImage(name: string): Promise<ImageProps>;
  getOthersEquipCard(cardName: string): Promise<ImageProps>;
  getSlimEquipCard(cardName: string): Promise<ImageProps>;
  getSlimCard(cardName: string): Promise<ImageProps>;
  getPlayerRoleCard(role: PlayerRole): Promise<ImageProps>;

  getCardBack(): ImageProps;
  getBackgroundImage(): ImageProps;
  getEmptySeatImage(): ImageProps;
  getUnknownCharacterImage(): ImageProps;
  getCardNumberBgImage(): ImageProps;
  getTurnedOverCover(): ImageProps;
  getChainImage(): ImageProps;
}
