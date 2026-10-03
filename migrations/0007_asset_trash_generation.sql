ALTER TABLE assets ADD COLUMN trash_generation TEXT
    CHECK (trash_generation IS NULL OR (
        length(trash_generation) = 32 AND trash_generation NOT GLOB '*[^0-9a-f]*'
    ));

UPDATE assets SET trash_generation = lower(hex(randomblob(16)))
WHERE status = 'deleted';
