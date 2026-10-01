# SiteExpense — Attachment Upload Bug Debug Log


Date: 26/08/2026
Devloper: Shashank Singh Parihar

## 1. Issue Summary

### Reported behavior

The SiteExpense expense form originally behaved incorrectly when attachments were selected in multiple upload actions.

Observed sequence:

1. User opened **New Expense**.
2. User selected attachment `test4`.
3. `test4` appeared in the attachment preview.
4. User clicked the attachment/upload area again.
5. User selected `test3`.
6. The UI replaced `test4` with `test3`.

Expected behavior:

```text
Select test4
    ↓
test4 remains attached

Select test3
    ↓
test4 + test3 both remain attached
```

The application allows multiple attachments per expense, so selecting files in multiple rounds should accumulate the selected files rather than replace the previous selection.

---

## 2. Investigation Environment

The investigation was performed on a separate **Laptop/local copy** rather than the production ServerPC.

- Project: `D:\Projects\sitexpense`
- Windows
- Node.js: `v24.19.0`
- npm: `11.17.0`
- pnpm: `11.20.0`
- PostgreSQL was configured locally for the test environment.
- The production ServerPC was not modified during this debugging work.

Dependencies were installed locally with:

```powershell
pnpm install
```

The application uses:

- Node.js
- Express
- PostgreSQL
- Multer
- `public/app.js` for the browser-side application
- `src/api.js` and `src/db.js` for backend/database functionality

---

## 3. How the Problem Was Localized

The browser's network/request inspection was used to determine where the first attachment disappeared.

Observed sequence:

```text
First selection:
test4

Second selection:
test3

Request after second selection:
test3 only
```

The previously selected `test4` was already absent from the request before the request reached the backend.

This established that the overwrite was happening on the **frontend side**, rather than being caused by PostgreSQL updating an existing record or the backend replacing a stored file.

This was important because it allowed the investigation to avoid unnecessary changes to:

- PostgreSQL
- database schema
- API upload handling
- server-side storage
- existing production records/files

---

## 4. Original Frontend Structure

The relevant expense form was in:

```text
public/app.js
```

The attachment input was:

```html
<input
  type="file"
  id="ef-file"
  accept="image/*,application/pdf"
  multiple
  style="display:none"
  onchange="..."
>
```

The original submission logic relied directly on the file input's `FileList`.

Conceptually:

```js
const files = $('#ef-file').files;

for (const f of files) {
  fd.append('photos', f);
}
```

### Why this caused the problem

A browser `<input type="file">` represents the files selected in that input selection.

Selecting another group of files does not automatically append them to the previous selection.

Therefore, treating:

```js
$('#ef-file').files
```

as the permanent list meant the previous selection could disappear when another selection was made.

---

# 5. Root Cause

### Root cause

The frontend was using the current HTML file input selection as the complete attachment collection.

When another file was selected, the browser's file input represented the new selection. The application did not maintain its own accumulated attachment list.

Therefore:

```text
Select test4
    ↓
input.files = [test4]

Select test3
    ↓
input.files = [test3]
```

instead of:

```text
ExpenseForm.files = [test4, test3]
```

As a result, only the latest selection was included in the API request.

---

# 6. Fix Implemented

An application-level attachment collection was introduced:

```js
const ExpenseForm = {
  files: [],
  ...
};
```

`ExpenseForm.files` became the authoritative list of attachments for the current expense form.

The browser file input is now treated as the source of each new selection, while `this.files` holds the accumulated list.

---

# 7. New File Selection Logic

The file input was changed to call:

```html
onchange="ExpenseForm.addFiles(this.files)"
```

The new method is:

```js
addFiles(newFiles) {
  const duplicates = [];

  for (const file of newFiles) {
    const duplicate = this.files.some(existing =>
      existing.name === file.name &&
      existing.size === file.size &&
      existing.lastModified === file.lastModified &&
      existing.type === file.type
    );

    if (duplicate) {
      duplicates.push(file.name);
    } else {
      this.files.push(file);
    }
  }

  this.preview();
  $('#ef-file').value = '';

  if (duplicates.length) {
    toast(
      duplicates.length === 1
        ? `${duplicates[0]} is already attached`
        : `${duplicates.length} selected files are already attached`,
      'err'
    );
  }
}
```

---

# 8. Why `this.files` Was Added

The purpose of:

```js
files: []
```

is to maintain an application-level collection that survives individual file-input selections while the expense form remains open.

The new flow is:

```text
User selects file A
       ↓
input.files contains A
       ↓
addFiles()
       ↓
ExpenseForm.files = [A]
       ↓
input is cleared

User selects file B
       ↓
input.files contains B
       ↓
addFiles()
       ↓
ExpenseForm.files = [A, B]
       ↓
input is cleared
```

The browser input can therefore be cleared after every selection without losing files already attached to the expense form.

---

# 9. Why the File Input Is Cleared

After processing a selection:

```js
$('#ef-file').value = '';
```

is used intentionally.

This allows the user to select the same physical file again and have the browser generate another selection/change event.

The application itself then decides whether that file is a duplicate.

Without clearing the input, selecting the same file again may not trigger the expected `change` event because the input's selected value has not changed.

---

# 10. Duplicate Detection

Once multiple selections were allowed, another issue was identified:

```text
Select test4
Select test4 again
```

could otherwise add the same file more than once.

Duplicate detection was therefore added.

A file is considered a duplicate when all of these match:

```js
existing.name === file.name
existing.size === file.size
existing.lastModified === file.lastModified
existing.type === file.type
```

This provides a practical client-side identity check without uploading the file merely to determine whether it is already attached.

---

# 11. Duplicate Feedback

The application reports duplicate selections.

For one duplicate:

```text
test4.pdf is already attached
```

For multiple duplicates:

```text
2 selected files are already attached
```

The duplicate files are not added again.

The UI intentionally reports the count when multiple duplicate files are selected.

---

# 12. Preview Changes

The preview now uses:

```js
const files = this.files;
```

rather than treating the file input's current `FileList` as the complete attachment list.

The flow is:

```text
ExpenseForm.files
       ↓
    preview()
       ↓
   ef-thumbs
```

This is important because the file input is cleared after each selection.

The preview therefore continues to show all accumulated files.

---

# 13. Submission Changes

Final submission uses:

```js
const files = this.files;

for (const f of files) {
  fd.append('photos', f);
}
```

Therefore:

```text
ExpenseForm.files
    ↓
FormData
    ↓
photos
    ↓
POST /expenses
```

All accumulated attachments are sent together.

---

# 14. Why the Backend Was Not Changed

The investigation showed that the first file was already absent from the HTTP request.

Therefore, the backend was not responsible for the initial overwrite behavior.

No changes were required to:

- PostgreSQL
- database schema
- `src/db.js`
- `src/api.js`
- Multer configuration
- server-side upload storage
- existing uploaded files
- existing database records

This avoided unnecessary production changes.

---

# 15. Testing Performed

## Test 1 — Sequential file selection

```text
Select test4
    ↓
test4 shown

Select test3
    ↓
test4 + test3 shown
```

**Result: PASS**

---

## Test 2 — Additional files

Multiple files could be added through successive selection actions without replacing previous files.

**Result: PASS**

---

## Test 3 — Duplicate selection

Selecting an already attached file no longer created another copy.

**Result: PASS**

---

## Test 4 — Duplicate reporting

The UI reports duplicate selection and reports the number when multiple duplicate files are selected.

**Result: PASS**

---

## Test 5 — PDF support

The expense form accepts:

```html
accept="image/*,application/pdf"
```

PDF files receive a PDF-style preview while images receive image previews.

**Result: PASS**

---

# 16. Attachment Limit

During the investigation, the application referenced an attachment limit of approximately 12 files.

The requirement was discussed with the relevant authorities/users.

Typical expenses are expected to contain around two attachments, so 12 was considered a sufficiently large safety buffer.

Therefore:

**The attachment limit was intentionally not expanded.**

---

# 17. Final Attachment Pipeline

```text
                  USER
                    │
                    ▼
             File selection
                    │
                    ▼
             #ef-file input
                    │
                    ▼
          ExpenseForm.addFiles()
                    │
             ┌──────┴──────┐
             │             │
         Duplicate?       New?
             │             │
             ▼             ▼
        Report it      this.files.push()
                           │
                           ▼
                     preview()
                           │
                           ▼
                    ef-thumbs UI
                           │
                           │
                  User selects more
                           │
                           ▼
                  addFiles() again
                           │
                           ▼
                    this.files[]
                           │
                           ▼
                     Submit
                           │
                           ▼
                      FormData
                           │
                           ▼
                    POST /expenses
                           │
                           ▼
                     Backend/API
                           │
                           ▼
                  Storage + database
```

The critical architectural change is:

> The browser file input is now a source of individual selections; `ExpenseForm.files` is the accumulated attachment collection for the current expense.

---

# 18. Production Deployment Status

At the time this debugging work was completed:

**Production ServerPC was not modified.**

The fix was developed and tested on:

```text
D:\Projects\sitexpense
```

on the separate Laptop.

Planned production deployment:

1. Back up the existing production `public/app.js`.
2. Replace only the tested frontend file.
3. Do not modify PostgreSQL.
4. Do not modify existing uploaded files.
5. Do not modify backend upload logic.
6. Do not unnecessarily restart the SiteExpense process.
7. Test production upload behavior after deployment.

Because there are currently users working on the ServerPC, deployment should be performed carefully and only after approval.

---

# 19. Final Finding

### Before

```text
File A selected
    ↓
File A in browser input

File B selected
    ↓
Browser input now represents File B
    ↓
API request contains B
    ↓
A is missing
```

### After

```text
File A selected
    ↓
ExpenseForm.files = [A]

File B selected
    ↓
ExpenseForm.files = [A, B]

Submit
    ↓
FormData contains A + B
    ↓
API
    ↓
Server storage/database
```

### Status

**Attachment overwrite issue: RESOLVED AND LOCALLY TESTED**

Current behavior:

- Multiple files can be selected across multiple selection actions.
- Previously selected files remain attached.
- Duplicate files are prevented.
- Duplicate-selection feedback is displayed.
- Images and PDFs are supported.
- Existing PostgreSQL data is untouched.
- Production ServerPC remains unchanged pending approval.

---

# 20. Debugging Lesson

For future upload issues, trace the complete pipeline:

```text
Frontend selection
      ↓
Frontend state
      ↓
HTTP request
      ↓
Backend handler
      ↓
Storage
      ↓
Database
      ↓
Frontend display
```

In this case, inspecting the HTTP request early was decisive.

The first file was already missing from the request. That localized the problem to the frontend and prevented unnecessary database/backend investigation or destructive changes.
