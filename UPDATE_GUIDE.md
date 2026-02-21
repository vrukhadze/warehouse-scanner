# Warehouse Scanner – Quick Update Guide

მოკლე ინსტრუქცია, რომ სკანერის განახლება ყოველთვის ერთნაირად გააკეთო.

## 1) რა ფაილს ვცვლით

მოქმედი ფაილი:

- `index.html`

## 2) ლოკალური შემოწმება

სწრაფი გახსნა ბრაუზერში:

```bash
open "/Users/vano/Documents/Projects/Warehouse Sales Project/warehouse-scanner/index.html"
```

ან VS Code Live Server-ით გაუშვი და ფუნქციები გადაამოწმე:
- სკანირება
- ხელით კოდის დამატება
- რაოდენობის +/-
- დასრულება (send flow)

## 3) ბოტთან კავშირის ლოგიკა

`ai_bot_project/final_bot.py` იყენებს URL-ს:

- `SCANNER_BASE_URL = https://vrukhadze.github.io/warehouse-scanner/`

ამიტომ deploy-ის მერე ბოტი ავტომატურად ახალ ვერსიას დაინახავს (თუ იგივე URL დარჩა).

## 4) Deploy (რადგან GitHub Pages URL გამოიყენება)

`warehouse-scanner` პროექტიდან:

```bash
git add index.html
git commit -m "update scanner"
git push
```

დაელოდე Pages-ის განახლებას, მერე ბოტიდან გახსენი სკანერი და გადაამოწმე.

## 5) თუ რამე აირია

- შეამოწმე URL სწორია თუ არა `final_bot.py`-ში.
- შეამოწმე ბოლო ცვლილება ნამდვილად `warehouse-scanner/index.html`-შია.
- საჭიროებისას ძველ commit-ზე დაბრუნდი `warehouse-scanner` რეპოში.
