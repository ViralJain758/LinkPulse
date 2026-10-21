import { Router } from 'express';
import { query, isUniqueViolation } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { MAX_FOLDERS_PER_USER, parseFolderName } from '../services/linkFields.js';

const router = Router();
router.use(requireAuth);

const toResponse = (row) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  // Only present when the query selected it (the list endpoint)
  ...(row.link_count !== undefined && { linkCount: row.link_count }),
});

// GET /api/folders  -> folders by name, each with its number of links
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT f.*, (SELECT COUNT(*)::int FROM links l WHERE l.folder_id = f.id) AS link_count
       FROM folders f WHERE f.user_id = $1 ORDER BY lower(f.name)`,
      [req.user.id]
    );
    res.json(rows.map(toResponse));
  } catch (err) {
    next(err);
  }
});

// POST /api/folders  { name }
router.post('/', async (req, res, next) => {
  try {
    const name = parseFolderName(req.body?.name);
    if (name.error) return res.status(400).json({ error: name.error });

    const { rows: count } = await query('SELECT COUNT(*)::int AS n FROM folders WHERE user_id = $1', [req.user.id]);
    if (count[0].n >= MAX_FOLDERS_PER_USER) {
      return res.status(400).json({ error: `You can have at most ${MAX_FOLDERS_PER_USER} folders` });
    }

    try {
      const { rows } = await query(
        'INSERT INTO folders (user_id, name) VALUES ($1, $2) RETURNING *, 0 AS link_count',
        [req.user.id, name.value]
      );
      res.status(201).json(toResponse(rows[0]));
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'A folder with that name already exists' });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// PATCH /api/folders/:id  { name }
router.patch('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const name = parseFolderName(req.body?.name);
    if (name.error) return res.status(400).json({ error: name.error });

    try {
      const { rows } = await query(
        `UPDATE folders SET name = $1 WHERE id = $2 AND user_id = $3
         RETURNING *, (SELECT COUNT(*)::int FROM links l WHERE l.folder_id = folders.id) AS link_count`,
        [name.value, id, req.user.id]
      );
      if (!rows[0]) return res.status(404).json({ error: 'Folder not found' });
      res.json(toResponse(rows[0]));
    } catch (err) {
      if (isUniqueViolation(err)) return res.status(409).json({ error: 'A folder with that name already exists' });
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// DELETE /api/folders/:id  -> 204. The folder's links are kept and become unfiled.
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
    const { rowCount } = await query('DELETE FROM folders WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Folder not found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
