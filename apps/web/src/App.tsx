import { Route, Routes, useParams } from 'react-router-dom';
import { Preview } from './Preview';
import { CreatePage } from './pages/CreatePage';
import { NotFound } from './pages/NotFound';
import { RoomPage } from './pages/RoomPage';
import { isRoomSlug } from './lib/slug';

function SlugRoute() {
  const { slug = '' } = useParams<{ slug: string }>();
  if (!isRoomSlug(slug)) return <NotFound />;
  return <RoomPage slug={slug} />;
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<CreatePage />} />
      <Route path="/preview" element={<Preview />} />
      <Route path="/:slug" element={<SlugRoute />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
