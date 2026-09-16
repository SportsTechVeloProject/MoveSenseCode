# Database

We use **Supabase** as our backend — hosted Postgres plus built-in Auth and file Storage. No separate server to build or run.

## Structure

| Table | Purpose |
|---|---|
| `coaches` | One row per coach account (linked to Supabase Auth) |
| `athletes` | One row per athlete |
| `coach_athletes` | Links coaches and athletes (many-to-many) |
| `sessions` | One row per recording: exercise, weight, a pointer to the raw sensor data in Storage, and the coach's reported rep count |
| `reps` | One row per detected rep: left/right velocity data, concentric/eccentric timing, and a `metrics` field for newer/experimental values |

Row Level Security means a coach only sees data for athletes they're linked to.

<img width="636" height="602" alt="image" src="https://github.com/user-attachments/assets/00881ca5-b8dc-412a-bcca-7c77ff05be82" />
