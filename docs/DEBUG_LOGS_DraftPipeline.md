# SiteExpense — Local Draft / IndexedDB Debug Log

Date: 26/08/2026
Devloper: Shashank Singh Parihar

## 1. Feature Request

The existing **Save as Draft** behavior was identified as undesirable for the intended workflow.

### Existing behavior

Clicking:

```text
Save Draft
    ↓
POST /expenses
    ↓
Database record created
```

The draft was therefore being stored as an actual SiteExpense database record.

The application also had an Edit button associated with some draft records, but the users had not been using that workflow. The administrator/supervisor was not aware that the Edit button existed, and their actual workflow was to make changes only after an item had been flagged/query-raised by a checker.

The requested behavior was therefore changed to:

```text
Save as Draft
    ↓
NO database record
    ↓
Keep the unfinished expense locally
```

The user wanted the draft to survive page reloads/browser closure and wanted attachments to survive as well.

---

# 2. Requirements

The agreed draft behavior is:

### Save Draft

When the user clicks **Save Draft**:

- Do not call the SiteExpense API.
- Do not create a PostgreSQL record.
- Do not upload attachments to the server.
- Do not close the expense form.
- Store the unfinished form locally.
- Store the attachments locally.
- Allow the user to continue working.

### Returning later

If a saved local draft exists and the user clicks **Add Expense**, SiteExpense should show a proper application UI prompt:

> Saved Expense Draft Found

with:

- **Continue Draft**
- **Start New**

### Continue Draft

Continue Draft should restore:

- Date
- Amount
- Category
- Expense Details
- Project
- Location
- Done by
- Bill received
- Bill number
- Remark
- Attachments

### Start New

Start New should:

- Replace the existing local draft.
- Clear the old form data.
- Clear the old attachments.
- Start a new blank expense.
- Not create a database record.

No separate **Discard Draft** button was added because it would create another potentially misclickable action.

### Successful submission

When the user submits the expense successfully:

```text
POST succeeds
    ↓
Clear local draft
```

If submission fails:

```text
POST fails
    ↓
Keep local draft
```

This prevents accidental loss of the user's work during a network/API failure.

---

# 3. Why localStorage Alone Was Not Enough

Initially, localStorage was considered for draft storage.

localStorage is suitable for simple text/JSON data such as:

```text
Date
Amount
Category
Details
Project
Location
Remark
```

However, the draft requirement also includes:

```text
Image files
PDF files
```

A browser file input contains `File` objects.

The requirement was for attachments to survive:

- page reload
- closing the browser
- reopening the browser
- restarting the PC

while remaining local to the user's browser/device.

For this reason, IndexedDB was selected.

---

# 4. IndexedDB

IndexedDB is a persistent database built into the user's browser.

It is separate from PostgreSQL.

The architecture is:

```text
User's Browser
│
└── SiteExpense IndexedDB
      │
      └── current draft
            ├── form fields
            └── File objects
```

Production PostgreSQL is not involved when the draft is saved locally.

---

# 5. PostgreSQL Impact

Saving a local draft does **not** modify PostgreSQL.

The intended lifecycle is:

```text
Save Draft
    ↓
IndexedDB only
    ↓
PostgreSQL: NO CHANGE
```

Only actual submission reaches the server:

```text
Submit
    ↓
POST /expenses
    ↓
Backend
    ↓
PostgreSQL + server-side file storage
```

This means the local draft feature does not create database draft records.

It also avoids adding draft rows that would need later cleanup.

---

# 6. Persistence Behavior

IndexedDB is persistent browser storage.

The local draft is expected to remain after:

| Event | Draft |
|---|---|
| Page refresh | Remains |
| Closing SiteExpense tab | Remains |
| Closing browser | Remains |
| Reopening browser | Remains |
| Restarting PC | Remains |
| Normal browser crash | Normally remains |
| Clearing browser/site data | Removed |
| Removing/resetting browser profile | May be removed |
| Successful SiteExpense submission | Explicitly removed by application |
| Start New | Explicitly replaced by application |

The draft is therefore intended as a recovery mechanism for unfinished work, not as a server-side shared draft.

---

# 7. Device/Browser Scope

The draft is stored in the browser on the device where the user created it.

Therefore:

```text
Laptop A
    ↓
SiteExpense draft
    ↓
Laptop A browser only
```

The draft does not automatically follow the user to:

```text
Laptop B
ServerPC
another browser
another browser profile
```

This is intentional.

The feature is designed primarily to protect users against:

- page refresh
- browser closure
- accidental navigation
- temporary interruption
- returning later on the same device

---

# 8. Implementation Location

The implementation was made in:

```text
public/app.js
```

This is the frontend application code.

The existing application serves `public` as static frontend content.

The draft functionality is therefore browser-side functionality and does not require changes to:

```text
src/api.js
src/db.js
server.js
PostgreSQL
```

for the local-save operation.

---

# 9. IndexedDB Helper

A new `ExpenseDraft` helper was added before the expense form code.

Conceptually:

```js
const ExpenseDraft = {
  dbName: 'sitexpense-local',
  storeName: 'drafts',
  key: 'current',

  async db() {
    ...
  },

  async save(data) {
    ...
  },

  async load() {
    ...
  },

  async clear() {
    ...
  }
};
```

The IndexedDB database is named:

```text
sitexpense-local
```

and the object store is:

```text
drafts
```

The application uses:

```text
current
```

as the key.

This deliberately implements a **single active local draft** rather than a complete draft-management system.

---

# 10. Why Only One Draft

The normal SiteExpense workflow is one expense being prepared at a time.

The desired user experience was intentionally kept simple:

```text
One active local draft
```

If a draft exists:

```text
Add Expense
    ↓
Draft prompt
    ↓
Continue Draft
OR
Start New
```

Starting a new expense replaces the old local draft.

This avoids adding:

- draft lists
- draft IDs
- draft management screens
- delete buttons
- extra navigation
- multiple simultaneous local drafts

---

# 11. Draft Data Structure

The draft stored in IndexedDB contains two major components:

```text
draft
├── fields
│   ├── date
│   ├── amount
│   ├── categoryId
│   ├── details
│   ├── projectId
│   ├── location
│   ├── expenseDoneBy
│   ├── billReceived
│   ├── billNo
│   └── remark
│
└── files
    ├── File object
    ├── File object
    └── ...
```

This allows both ordinary form information and actual attachments to persist locally.

---

# 12. `saveDraft()` Implementation

A new method was added to `ExpenseForm`:

```js
async saveDraft() {
  const fields = {
    date: $('#ef-date').value,
    amount: $('#ef-amt').value,
    categoryId: $('#ef-cat').value,
    details: $('#ef-det').value,
    projectId: $('#ef-prj').value,
    location: $('#ef-loc').value,
    expenseDoneBy: $('#ef-by').value,
    billReceived: $('#ef-billrec').value,
    billNo: $('#ef-billno').value,
    remark: $('#ef-rem').value,
  };

  await ExpenseDraft.save({
    fields,
    files: this.files
  });

  toast('Draft saved locally', 'ok');
}
```

The existing **Save Draft** button was changed from calling the API submission method:

```js
ExpenseForm.submit(true)
```

to:

```js
ExpenseForm.saveDraft()
```

This is the key behavioral change.

---

# 13. Before vs After Save Draft

### Before

```text
Save Draft
    ↓
ExpenseForm.submit(true)
    ↓
FormData
    ↓
POST /expenses
    ↓
PostgreSQL
    ↓
Draft database record
```

### After

```text
Save Draft
    ↓
ExpenseForm.saveDraft()
    ↓
ExpenseDraft.save()
    ↓
IndexedDB
    ↓
Form remains open
```

There is no API call in the local draft-save path.

---

# 14. Draft Restoration

A new method was added to `ExpenseForm`:

```js
async loadDraft() {
  const draft = await ExpenseDraft.load();
  if (!draft) return false;

  this.files = draft.files || [];

  const fields = draft.fields || {};

  const values = {
    'ef-date': fields.date || new Date().toISOString().slice(0, 10),
    'ef-amt': fields.amount || '',
    'ef-cat': fields.categoryId || '',
    'ef-det': fields.details || '',
    'ef-prj': fields.projectId || '',
    'ef-loc': fields.location || '',
    'ef-by': fields.expenseDoneBy || S.user.name,
    'ef-billrec': fields.billReceived || 'No',
    'ef-billno': fields.billNo || '',
    'ef-rem': fields.remark || '',
  };

  for (const [id, value] of Object.entries(values)) {
    const el = $('#' + id);
    if (el) el.value = value;
  }

  this.preview();
  return true;
}
```

This restores both:

```text
form values
+
attachments
```

from the browser-local draft.

---

# 15. Why the Form Must Be Created Before Restoration

The expense form fields are created by:

```js
Modal.open(...)
```

Therefore, fields such as:

```text
#ef-date
#ef-amt
#ef-cat
#ef-det
...
```

do not exist until the expense modal has been opened.

The restoration sequence therefore has to be:

```text
Check draft
    ↓
Open expense form/modal
    ↓
DOM fields now exist
    ↓
Load draft values
    ↓
Restore attachments
    ↓
Preview attachments
```

Attempting to populate the fields before the modal exists would fail because the elements would not yet be present in the DOM.

---

# 16. Draft Detection

`ExpenseForm.open()` was changed to check IndexedDB before opening a new expense.

Conceptually:

```js
const existingDraft = await ExpenseDraft.load();

if (existingDraft) {
  ...
}
```

This gives SiteExpense the opportunity to detect unfinished local work before presenting a new blank expense.

---

# 17. User Interface Prompt

The initial implementation used the browser's built-in:

```js
confirm(...)
```

dialog.

Although functional, this was visually inconsistent with SiteExpense.

It was replaced with a normal SiteExpense modal using the application's existing `Modal` system.

The application already provides:

```js
const Modal = {
  open(html) {
    ...
  },

  close() {
    ...
  }
};
```

No new modal framework was introduced.

---

# 18. Final Draft Prompt

When a local draft exists, the user now sees a SiteExpense-style modal:

```text
┌─────────────────────────────────────────┐
│ Saved Expense Draft Found               │
├─────────────────────────────────────────┤
│ You have an unfinished expense saved    │
│ on this device.                         │
│                                         │
│ Would you like to continue it or start  │
│ a new expense?                          │
├─────────────────────────────────────────┤
│             Start New  Continue Draft   │
└─────────────────────────────────────────┘
```

The two choices are:

### Continue Draft

Restores the local draft.

### Start New

Replaces the old local draft and opens a new blank expense.

---

# 19. Why There Is No Discard Draft Button

A separate **Discard Draft** button was intentionally not added.

The agreed workflow is:

```text
Existing draft
    ↓
Continue Draft
OR
Start New
```

If the user chooses Start New:

```text
Old draft
    ↓
Replaced
    ↓
New draft/form
```

This avoids creating an additional permanent button that could be accidentally clicked.

A confirmation can be used around replacing an existing draft if desired, but there is no separate Discard Draft control.

---

# 20. Start New Behavior

When the user selects **Start New**:

```text
Existing local draft
    ↓
ExpenseDraft.clear()
    ↓
this.files = []
    ↓
New blank expense
```

The old local draft is therefore replaced.

No PostgreSQL record is deleted because the draft never existed in PostgreSQL.

---

# 21. Attachment Persistence

A major requirement was that attachments survive reloads.

The existing upload fix introduced:

```js
ExpenseForm.files
```

as the accumulated attachment collection.

The draft system stores that collection:

```js
files: this.files
```

in IndexedDB.

On restoration:

```js
this.files = draft.files || [];
```

and then:

```js
this.preview();
```

rebuilds the attachment preview.

Therefore:

```text
Select test3
Select test4
    ↓
this.files = [test3, test4]
    ↓
Save Draft
    ↓
IndexedDB
    ↓
Reload browser
    ↓
Continue Draft
    ↓
this.files restored
    ↓
test3 + test4 shown again
```

---

# 22. Successful Submission Cleanup

A bug was found during testing:

After submitting a restored draft successfully, the next **Add Expense** still displayed the draft prompt.

### Cause

The server submission succeeded, but the local IndexedDB draft had not yet been removed.

Therefore:

```text
Submit
    ↓
API succeeds
    ↓
Local draft still exists
    ↓
Next Add Expense
    ↓
Draft prompt appears again
```

### Fix

After the API confirms successful submission:

```js
const r = await api('POST', '/expenses', fd, true);
await ExpenseDraft.clear();
```

The local draft is cleared only after the server accepts the expense.

---

# 23. Why Cleanup Happens After API Success

This ordering is deliberate.

### Successful request

```text
Submit
    ↓
API succeeds
    ↓
Clear local draft
```

### Failed request

```text
Submit
    ↓
API/network failure
    ↓
Do NOT clear draft
```

This prevents a failed submission from destroying the user's only local copy.

The local draft therefore acts as a recovery mechanism during submission failures.

---

# 24. Final Draft Lifecycle

The complete lifecycle is now:

```text
                  ADD EXPENSE
                       │
                       ▼
              Check IndexedDB
                       │
             ┌─────────┴─────────┐
             │                   │
        No draft              Draft exists
             │                   │
             ▼                   ▼
        Blank form        SiteExpense prompt
                               │
                      ┌────────┴────────┐
                      │                 │
               Continue Draft       Start New
                      │                 │
                      ▼                 ▼
               Restore fields       Clear old
               + attachments         draft
                      │                 │
                      └────────┬────────┘
                               ▼
                         Expense form
                               │
                    User enters/changes data
                               │
                               ▼
                         Save as Draft
                               │
                               ▼
                           IndexedDB
                               │
                               ▼
                         Continue working
                               │
                               ▼
                         Submit for review
                               │
                               ▼
                         POST /expenses
                               │
                       ┌───────┴────────┐
                       │                │
                    Failure          Success
                       │                │
                       ▼                ▼
                  Keep draft       Clear draft
                                        │
                                        ▼
                                  Normal expense
                                  in PostgreSQL
```

---

# 25. Testing Performed

## Test 1 — Save Draft

Entered test expense data and selected an attachment.

Clicked:

```text
Save Draft
```

Observed:

- Local save confirmation displayed.
- Form remained open.
- No database submission was required.

**Result: PASS**

---

## Test 2 — Reload

After saving a draft:

```text
Ctrl + R
```

was used to reload the page.

At this intermediate stage, the draft did not automatically load because restoration had not yet been wired.

This confirmed that persistence and restoration were separate implementation steps.

**Result: Expected behavior during development**

---

## Test 3 — Continue Draft

After restoration was implemented:

```text
Refresh
    ↓
Add Expense
    ↓
Saved Expense Draft Found
    ↓
Continue Draft
```

The following were restored:

- form values
- attachments

**Result: PASS**

---

## Test 4 — Attachment persistence

A saved draft containing attachments was reloaded and restored.

The attachments appeared again in the evidence-photo area.

**Result: PASS**

This confirmed that IndexedDB was successfully preserving the file data.

---

## Test 5 — Start New

A saved draft existed.

The user selected:

```text
Start New
```

The old draft was replaced.

The new expense form did not contain the previous draft's:

- form values
- attachments

**Result: PASS**

---

## Test 6 — Replace old draft

After starting a new expense, new data and a new attachment were saved.

The page was reloaded.

The new draft was restored instead of the previous draft.

**Result: PASS**

---

## Test 7 — Submit restored draft

A saved draft was restored and submitted normally.

The expense was successfully submitted.

Then **Add Expense** was opened again.

The old draft prompt no longer appeared.

**Result: PASS**

This confirmed that successful submission correctly clears the local draft.

---

# 26. Current Database Impact

During the local draft testing:

```text
Save Draft
    ↓
IndexedDB
```

No production PostgreSQL database was modified.

The purpose of this feature is specifically to prevent unfinished local drafts from becoming database records.

Only successful submission enters the normal backend/database workflow.

---

# 27. Production Status

The draft feature was implemented and tested on the separate Laptop.

The production ServerPC has not been changed as part of this work.

Production deployment should only occur after the supervisor/admin approves the behavior.

The intended deployment is a frontend change in:

```text
public/app.js
```

No database migration should be required.

---

# 28. Operational Considerations

## Browser-local nature

The draft is tied to the browser/device.

This is intentional.

It is not a shared company-wide draft.

## Browser storage clearing

If the user or an IT/browser policy clears SiteExpense's browser storage, the local draft may be lost.

Therefore the feature should be considered a convenience/recovery mechanism, not a permanent backup system.

## Successful submission

The application explicitly deletes the local draft after successful submission so that stale drafts do not appear later.

## Failed submission

The draft remains when the submission fails, allowing the user to retry.

---

# 29. Why This Design Was Chosen

The design satisfies the requested behavior without introducing server-side draft records.

Advantages:

- No unnecessary PostgreSQL draft records.
- No server-side temporary upload management.
- No draft cleanup jobs.
- Attachments survive page reloads.
- Browser closure does not normally destroy the draft.
- The form can recover after interruption.
- The user explicitly chooses whether to continue or replace a draft.
- Existing production API/database behavior remains unchanged for actual submission.
- The unused Edit workflow can be disregarded for this local-draft workflow.

---

# 30. Final Architecture

```text
                    SITEEXPENSE
                         │
              ┌──────────┴──────────┐
              │                     │
          LOCAL DRAFT             SUBMIT
              │                     │
              ▼                     ▼
          IndexedDB              API request
              │                     │
       ┌──────┴──────┐              ▼
       │             │          Backend
     Fields        Files           │
       │             │             ▼
       └──────┬──────┘        PostgreSQL
              │                + uploads
              ▼
       Browser-local only
```

---

# 31. Final Status

**Local Draft Feature: IMPLEMENTED AND LOCALLY TESTED**

Current behavior:

- Save Draft is local only.
- No PostgreSQL record is created by Save Draft.
- The form remains open after Save Draft.
- Form data persists in IndexedDB.
- Attachments persist in IndexedDB.
- Browser/page reload does not lose the local draft under normal conditions.
- Add Expense detects an existing draft.
- SiteExpense UI prompts the user to Continue Draft or Start New.
- Continue Draft restores fields and attachments.
- Start New replaces the previous local draft.
- No separate Discard Draft button exists.
- Successful submission clears the local draft.
- Failed submission preserves the local draft.
- The production ServerPC has not been modified.

---

# 32. Debugging Lessons

### Lesson 1 — Separate local draft state from server records

A "draft" does not necessarily need to be a database record.

For this workflow, local browser persistence is sufficient and avoids unnecessary backend complexity.

### Lesson 2 — File persistence requires more than localStorage

When unfinished work includes actual attachments, a browser storage mechanism capable of holding file/blob data is required.

IndexedDB was therefore chosen.

### Lesson 3 — Clear local state only after successful submission

The correct order is:

```text
API success
    ↓
clear local draft
```

not:

```text
clear draft
    ↓
attempt API request
```

The latter could cause data loss if the network/API request fails.

### Lesson 4 — Keep user choices explicit

An existing draft should not silently replace a new expense form.

The user is shown:

```text
Continue Draft
Start New
```

This prevents an old unfinished expense from unexpectedly appearing when the user intended to create a new one.

---

# 33. Final Outcome

The old server-side draft workflow can now be conceptually replaced with:

```text
UNFINISHED EXPENSE
       ↓
Browser-local IndexedDB
       ↓
Continue later
       ↓
Submit when ready
       ↓
Only then create real SiteExpense record
```

This provides the requested draft experience while leaving PostgreSQL untouched until the actual expense is submitted.
