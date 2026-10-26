import { Route, Routes } from 'react-router-dom';
import { Layout } from './Layout';
import { RequireAuth } from '../components/RequireAuth';
import { LandingPage } from '../pages/LandingPage';
import { AuthPage } from '../pages/AuthPage';
import { PlayPage } from '../pages/PlayPage';
import { CompetitionsPage } from '../pages/CompetitionsPage';
import { TournamentsPage } from '../pages/TournamentsPage';
import { ChallengePage } from '../pages/ChallengePage';
import { GamePage } from '../pages/GamePage';
import { PuzzlesPage } from '../pages/PuzzlesPage';
import { LearnPage } from '../pages/LearnPage';
import { AnalysisPage } from '../pages/AnalysisPage';
import { TrainPage } from '../pages/TrainPage';
import { LeaderboardPage } from '../pages/LeaderboardPage';
import { WalletPage } from '../pages/WalletPage';
import { ProfilePage } from '../pages/ProfilePage';
import { HistoryPage } from '../pages/HistoryPage';
import { SettingsPage } from '../pages/SettingsPage';
import { HelpPage } from '../pages/HelpPage';
import { AdminPage } from '../pages/AdminPage';
import { AgentPage } from '../pages/AgentPage';
import { LegalPage } from '../pages/LegalPage';
import { NotFoundPage } from '../pages/NotFoundPage';

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<LandingPage />} />
        <Route path="auth" element={<AuthPage />} />
        <Route path="verify-email" element={<AuthPage />} />
        <Route path="reset-password" element={<AuthPage />} />
        <Route path="play" element={<PlayPage />} />
        <Route path="competitions" element={<CompetitionsPage />} />
        <Route path="tournaments" element={<TournamentsPage />} />
        <Route path="challenge/:idOrToken" element={<ChallengePage />} />
        <Route path="game/:id" element={<GamePage />} />
        <Route path="puzzles" element={<PuzzlesPage />} />
        <Route path="learn" element={<LearnPage />} />
        <Route path="analysis" element={<AnalysisPage />} />
        <Route path="train" element={<TrainPage />} />
        <Route path="leaderboard" element={<LeaderboardPage />} />
        <Route path="profile/:username" element={<ProfilePage />} />
        <Route path="help" element={<HelpPage />} />
        <Route path="legal" element={<LegalPage />} />
        <Route path="wallet" element={<RequireAuth><WalletPage /></RequireAuth>} />
        <Route path="history" element={<RequireAuth><HistoryPage /></RequireAuth>} />
        <Route path="settings" element={<RequireAuth><SettingsPage /></RequireAuth>} />
        <Route path="admin" element={<RequireAuth admin><AdminPage /></RequireAuth>} />
        <Route path="agent" element={<RequireAuth agent><AgentPage /></RequireAuth>} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
