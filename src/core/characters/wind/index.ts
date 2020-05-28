import { Character } from '../character';
import { CaoRen } from './caoren';
import { Weiyan } from './weiyan';
import { XiaoQiao } from './xiaoqiao';
import { YuJi } from './yuji';
import { ZhangJiao } from './zhangjiao';
import { ZhouTai } from './zhoutai';

export const WindCharacterPackage: (index: number) => Character[] = index => [
  new CaoRen(index++),

  new Weiyan(index++),

  new ZhouTai(index++),
  new YuJi(index++),
  new ZhangJiao(index++),
  new XiaoQiao(index++),
];
