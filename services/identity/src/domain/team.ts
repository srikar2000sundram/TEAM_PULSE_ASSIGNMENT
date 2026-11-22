export interface Team {
  readonly id: string;
  readonly name: string;
  readonly managerUserId: string;
  readonly createdAt: Date;
}

export interface TeamSummary {
  readonly team: Team;
  readonly memberCount: number;
}

export interface TeamMember {
  readonly id: string;
  readonly displayName: string;
}
