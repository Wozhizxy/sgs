import { Skill } from 'skills/skill';

export type CharacterProps = {
  id: number;
  name: string;
  maxHp: number;
  skills: Skill[];
};

export abstract class Character {
  protected id: number;
  protected name: string;
  protected maxHp: number;
  protected skills: Skill[];

  protected constructor(props: CharacterProps) {
    for (const [key, value] of Object.entries(props)) {
      this[key] = value;
    }
  }

  protected getSkillsDescrption() {
    return this.skills.map(skill => skill.Description);
  }
}
