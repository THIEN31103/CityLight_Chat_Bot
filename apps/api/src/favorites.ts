// Saved map views (map page "Vị trí đã lưu"): private to each user, no scope check needed
// (a view is only a centre + zoom; the cabinets shown are still filtered by the user's scope).
import { Body, Controller, Delete, Get, HttpCode, Inject, Module, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import { RequirePerm, type AuthedRequest } from './auth';
import { ApiError } from './errors';
import { SQL, type Sql } from './infra';

const MAX_PER_USER = 50;

const FavoriteBody = z.object({
  name: z.string().trim().min(1).max(80),
  center: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
  zoom: z.number().min(0).max(22),
});

interface Row { id: string; name: string; lat: number; lng: number; zoom: number }
const dto = (r: Row) => ({ id: r.id, name: r.name, center: { lat: r.lat, lng: r.lng }, zoom: r.zoom });

@Controller('favorites')
export class FavoritesController {
  constructor(@Inject(SQL) private readonly sql: Sql) {}

  @Get()
  @RequirePerm('map.view')
  async list(@Req() r: AuthedRequest) {
    const rows = await this.sql<Row[]>`SELECT id, name, lat, lng, zoom FROM map_favorites WHERE user_id = ${r.user!.id} ORDER BY created_at`;
    return rows.map(dto);
  }

  @Post()
  @RequirePerm('map.view')
  async add(@Req() r: AuthedRequest, @Body() body: unknown) {
    const b = FavoriteBody.parse(body);
    const n = await this.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM map_favorites WHERE user_id = ${r.user!.id}`;
    if ((n[0]?.n ?? 0) >= MAX_PER_USER) throw new ApiError(409, 'too_many_favorites', `Tối đa ${MAX_PER_USER} vị trí đã lưu`);
    const rows = await this.sql<Row[]>`
      INSERT INTO map_favorites (user_id, name, lat, lng, zoom) VALUES (${r.user!.id}, ${b.name}, ${b.center.lat}, ${b.center.lng}, ${b.zoom})
      RETURNING id, name, lat, lng, zoom`;
    return dto(rows[0]!);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePerm('map.view')
  async remove(@Req() r: AuthedRequest, @Param('id') id: string) {
    const fid = z.string().uuid().parse(id);
    const done = await this.sql`DELETE FROM map_favorites WHERE id = ${fid} AND user_id = ${r.user!.id} RETURNING id`;
    if (!done.length) throw new ApiError(404, 'not_found', 'Không tìm thấy vị trí đã lưu');
  }
}

@Module({ controllers: [FavoritesController] })
export class FavoritesModule {}
