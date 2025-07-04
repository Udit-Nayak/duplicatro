const { google } = require("googleapis");
const { getOAuth2Client } = require("../libs/googleOAuth");
const pool = require("../db");


const rescanDriveFiles = async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.google_tokens) {
      return res.status(400).json({ error: "Google Drive not connected" });
    }

    const auth = getOAuth2Client();
    auth.setCredentials(user.google_tokens);
    const drive = google.drive({ version: "v3", auth });

    const files = [];
    let nextPageToken = null;

    do {
      const result = await drive.files.list({
        pageSize: 1000,
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, md5Checksum)",
        q: "trashed = false",
        pageToken: nextPageToken || undefined,
      });

      files.push(...result.data.files);
      nextPageToken = result.data.nextPageToken;
    } while (nextPageToken);

    const { rows: dbFiles } = await pool.query(
      "SELECT file_id FROM drive_files WHERE user_id = $1",
      [user.id]
    );
    const dbFileIds = new Set(dbFiles.map((f) => f.file_id));
    const driveFileIds = new Set(files.map((f) => f.id));

    const deletedIds = [...dbFileIds].filter((id) => !driveFileIds.has(id));
    if (deletedIds.length > 0) {
      await pool.query(
        `DELETE FROM drive_files WHERE user_id = $1 AND file_id = ANY($2::text[])`,
        [user.id, deletedIds]
      );
    }

    for (const file of files) {
      const existsInDb = dbFileIds.has(file.id);
      if (existsInDb) {
        await pool.query(
          `UPDATE drive_files 
           SET name = $1, size = $2, mime_type = $3, modified = $4, parent_id = $5, content_hash = $6
           WHERE user_id = $7 AND file_id = $8`,
          [
            file.name,
            Number(file.size) || 0,
            file.mimeType,
            file.modifiedTime,
            file.parents?.[0] || null,
            file.md5Checksum || null,
            user.id,
            file.id,
          ]
        );
      } else {
        await pool.query(
          `INSERT INTO drive_files 
           (user_id, file_id, name, size, mime_type, modified, parent_id, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            user.id,
            file.id,
            file.name,
            Number(file.size) || 0,
            file.mimeType,
            file.modifiedTime,
            file.parents?.[0] || null,
            file.md5Checksum || null,
          ]
        );
      }
    }

    await pool.query(
      `INSERT INTO scan_history (user_id, scan_type, scanned_files, scan_report)
       VALUES ($1, $2, $3, $4)`,
      [user.id, 'rescan', files.length, null]
    );

    res.json({ message: "Drive re-scanned and database updated." });
  } catch (err) {
    console.error("❌ Failed to rescan drive:", err.message);
    res.status(500).json({ error: "Rescan failed" });
  }
};

const scanDriveFiles = async (req, res) => {
  try {
    const user = req.user;
    if (!user || !user.google_tokens) {
      return res.status(400).json({ error: "Google Drive not connected" });
    }

    const auth = getOAuth2Client();
    auth.setCredentials(user.google_tokens);
    const drive = google.drive({ version: "v3", auth });

    const files = [];
    let nextPageToken = null;

    do {
      const result = await drive.files.list({
        pageSize: 1000,
        fields:
          "nextPageToken, files(id, name, mimeType, size, modifiedTime, parents, md5Checksum)",
        q: "trashed = false",
        pageToken: nextPageToken || undefined,
      });

      files.push(...result.data.files);
      nextPageToken = result.data.nextPageToken;
    } while (nextPageToken);

    await pool.query("DELETE FROM drive_files WHERE user_id = $1", [user.id]);

    for (const file of files) {
      try {
        await pool.query(
          `INSERT INTO drive_files 
            (user_id, file_id, name, size, mime_type, modified, parent_id, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            user.id,
            file.id,
            file.name,
            Number(file.size) || 0,
            file.mimeType,
            file.modifiedTime,
            file.parents?.[0] || null,
            file.md5Checksum || null, //
          ]
        );
      } catch (err) {
        console.warn(`⚠️ DB Insert Error [${file.name}]: ${err.message}`);
      }
    }

    const tree = buildDriveTree(files);
    res.json({ message: "Drive scanned and tree built", tree });
  } catch (err) {
    console.error("❌ Error scanning Drive:", err);
    res.status(500).json({ error: "Failed to scan Google Drive" });
  }
};

const listDriveFiles = async (req, res) => {
  try {
    const user = req.user;
    const {
      name,
      mimeType,
      modifiedAfter,
      modifiedBefore,
      sortBy = "modified",
      sortOrder = "desc",
    } = req.query;

    const validSortFields = ["name", "size", "mime_type", "modified"];
    const validSortOrders = ["asc", "desc"];

    let query = `SELECT * FROM drive_files WHERE user_id = $1`;
    const params = [user.id];

    if (name) {
      params.push(`%${name}%`);
      query += ` AND name ILIKE $${params.length}`;
    }

    if (mimeType) {
      params.push(mimeType);
      query += ` AND mime_type = $${params.length}`;
    }

    if (modifiedAfter) {
      params.push(modifiedAfter);
      query += ` AND modified >= $${params.length}`;
    }

    if (modifiedBefore) {
      params.push(modifiedBefore);
      query += ` AND modified <= $${params.length}`;
    }

    const safeSortBy = validSortFields.includes(sortBy) ? sortBy : "modified";
    const safeSortOrder = validSortOrders.includes(sortOrder.toLowerCase())
      ? sortOrder.toUpperCase()
      : "DESC";

    query += ` ORDER BY ${safeSortBy} ${safeSortOrder}`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error fetching filtered/sorted drive files:", err);
    res.status(500).json({ error: "Failed to fetch drive files" });
  }
};

const emptyTrash = async (req, res) => {
  try {
    const user = req.user;
    if (!user.google_tokens) {
      return res.status(400).json({ error: "Google Drive not connected" });
    }

    const auth = getOAuth2Client();
    auth.setCredentials(user.google_tokens);
    const drive = google.drive({ version: "v3", auth });

    await drive.files.emptyTrash();
    console.log(`🗑️ Trash emptied for user: ${user.email}`);
    res.status(200).json({ message: "Trash emptied successfully." });
  } catch (error) {
    console.error("❌ Failed to empty trash:", error.message);
    res.status(500).json({ error: "Failed to empty Drive trash" });
  }
};

function buildDriveTree(files) {
  const map = {};
  const roots = [];

  for (const file of files) {
    map[file.id] = { ...file, children: [] };
  }

  for (const file of files) {
    const parentId = file.parents?.[0];
    if (parentId && map[parentId]) {
      map[parentId].children.push(map[file.id]);
    } else {
      roots.push(map[file.id]);
    }
  }

  return roots;
}

module.exports = {
  scanDriveFiles,
  listDriveFiles,
  emptyTrash,
  rescanDriveFiles,
};
