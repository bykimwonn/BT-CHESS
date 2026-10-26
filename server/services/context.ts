import type { Database } from '../db/client.js';
import { evaluateCompliance, type ComplianceState } from '../config/compliance.js';
import { ConfigService } from './config-service.js';
import { createLogger, type AppLogger } from './logger.js';
import { Mailer } from './mailer.js';
import { EligibilityService } from '../eligibility/service.js';
import { AuthService } from '../auth/service.js';
import { LedgerService } from '../finance/ledger.js';
import { SettlementService } from '../finance/settlement.js';
import { GameService } from '../games/service.js';
import { CompetitionService } from '../competition/service.js';
import { createAdapters } from '../payments/registry.js';
import { PaymentService } from '../payments/service.js';
import { CashVoucherService } from '../cash/service.js';
import { EngineService } from '../engine/service.js';
import { AnalysisService } from '../engine/analysis.js';
import { AdminService } from '../admin/service.js';
import { TournamentService } from '../tournament/service.js';
import type { RealtimeService } from '../games/realtime.js';

export interface AppContext {
  db: Database;
  log: AppLogger;
  compliance: ComplianceState;
  config: ConfigService;
  mailer: Mailer;
  eligibility: EligibilityService;
  auth: AuthService;
  ledger: LedgerService;
  settlement: SettlementService;
  games: GameService;
  competition: CompetitionService;
  tournaments: TournamentService;
  payments: PaymentService;
  cash: CashVoucherService;
  engine: EngineService;
  analysis: AnalysisService;
  admin: AdminService;
  realtime: RealtimeService | null;
}

export function createContext(db: Database, log: AppLogger = createLogger()): AppContext {
  const compliance = evaluateCompliance();
  const config = new ConfigService(db);
  const mailer = new Mailer(log);
  const eligibility = new EligibilityService(db, compliance, log);
  const ledger = new LedgerService(db);
  const settlement = new SettlementService(db, ledger, log);
  const games = new GameService(db, settlement, log);
  const auth = new AuthService(db, ledger, mailer, log, eligibility);
  const competition = new CompetitionService(db, ledger, games, auth, config, eligibility, compliance, log);
  const tournaments = new TournamentService(db, games, eligibility, log);
  const adapters = createAdapters();
  const payments = new PaymentService(db, ledger, auth, eligibility, compliance, adapters, log);
  const cash = new CashVoucherService(db, ledger, compliance, log);
  const engine = new EngineService(log);
  const analysis = new AnalysisService(db, games, engine, log);
  const admin = new AdminService(db, compliance, config, auth, games, ledger, settlement, payments, engine, analysis, mailer, log);
  return {
    db, log, compliance, config, mailer, eligibility, auth, ledger, settlement, games,
    competition, tournaments, payments, cash, engine, analysis, admin, realtime: null,
  };
}
