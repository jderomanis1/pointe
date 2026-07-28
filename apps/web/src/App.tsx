import { Link, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Preview } from './Preview';
import { CreatePage } from './pages/CreatePage';
import { NotFound } from './pages/NotFound';
import { RetroHomePage } from './pages/RetroHomePage';
import { RetroPage } from './pages/RetroPage';
import { RoomPage } from './pages/RoomPage';
import { isRoomSlug } from './lib/slug';

function SlugRoute() {
  const { slug = '' } = useParams<{ slug: string }>();
  if (!isRoomSlug(slug)) return <NotFound />;
  return <RoomPage slug={slug} />;
}

function RetroSlugRoute() {
  const { slug = '' } = useParams<{ slug: string }>();
  if (!isRoomSlug(slug)) return <NotFound />;
  return <RetroPage slug={slug} />;
}

function ProductDock() {
  const location = useLocation();
  if (location.pathname !== '/') return null;
  return (
    <Link
      to="/retro"
      className="fixed bottom-4 right-4 z-40 max-w-[calc(100vw-2rem)] rounded-[18px] border border-hairline bg-text px-5 py-3 text-sm font-bold text-bg shadow-pop transition-transform hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:bottom-6 sm:right-6"
    >
      Running a retro? Start · Stop · Continue →
    </Link>
  );
}

export function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<CreatePage />} />
        <Route path="/retro" element={<RetroHomePage />} />
        <Route path="/retro/:slug" element={<RetroSlugRoute />} />
        <Route path="/preview" element={<Preview />} />
        <Route path="/:slug" element={<SlugRoute />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
      <ProductDock />
    </>
  );
}
